import url from "url";
import path from "path";
import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { createBinder, SymbolTable } from "./binder.js";
import { createChecker, MultiKeyMap } from "./checker.js";
import { CompilerOptions } from "./options.js";
import { parse } from "./parser.js";
import { resolvePath } from "./util.js";
import {
  ADLScriptNode,
  DecoratorExpressionNode,
  IdentifierNode,
  NamespaceType,
  LiteralType,
  ModelStatementNode,
  ModelType,
  SyntaxKind,
  Type,
  SourceFile,
  DecoratorSymbol,
} from "./types.js";
import { createSourceFile } from "./scanner.js";
import { throwDiagnostic } from "./diagnostics.js";

export interface Program {
  compilerOptions: CompilerOptions;
  globalSymbols: SymbolTable;
  sourceFiles: Array<ADLSourceFile>;
  typeCache: MultiKeyMap<Type>;
  literalTypes: Map<string | number | boolean, LiteralType>;
  checker?: ReturnType<typeof createChecker>;
  evalAdlScript(adlScript: string, filePath?: string): void;
  onBuild(cb: (program: Program) => void): void;
  executeNamespaceDecorators(type: NamespaceType): void;
  executeModelDecorators(type: ModelType): void;
  executeDecorators(type: Type): void;
}

export interface ADLSourceFile extends SourceFile {
  ast: ADLScriptNode;
  symbols: SymbolTable;
  models: Array<ModelType>;
  interfaces: Array<NamespaceType>;
}

export async function compile(rootDir: string, options?: CompilerOptions) {
  const buildCbs: any = [];

  const program: Program = {
    compilerOptions: options || {},
    globalSymbols: new SymbolTable(),
    sourceFiles: [],
    typeCache: new MultiKeyMap(),
    literalTypes: new Map(),
    evalAdlScript,
    executeNamespaceDecorators,
    executeModelDecorators,
    executeDecorators,
    onBuild(cb) {
      buildCbs.push(cb);
    },
  };

  let virtualFileCount = 0;
  const binder = createBinder();

  if (!options?.nostdlib) {
    await loadStandardLibrary(program);
  }

  await loadDirectory(program, rootDir);
  const checker = (program.checker = createChecker(program));
  program.checker.checkProgram(program);
  buildCbs.forEach((cb: any) => cb(program));

  /**
   * Evaluation resolves identifiers and type expressions and
   * does type checking.
   */

  function executeNamespaceDecorators(type: NamespaceType) {
    const stmt = type.node;

    for (const dec of stmt.decorators) {
      executeDecorator(dec, program, type);
    }

    for (const [_, modelType] of type.models) {
      executeModelDecorators(modelType);
    }

    for (const [_, namespaceType] of type.namespaces) {
      executeNamespaceDecorators(namespaceType);
    }

    for (const [_, propType] of type.operations) {
      for (const dec of propType.node.decorators) {
        executeDecorator(dec, program, propType);
      }
    }
  }

  function executeModelDecorators(type: ModelType) {
    const stmt = <ModelStatementNode>(type.templateNode || type.node);

    for (const dec of stmt.decorators) {
      executeDecorator(dec, program, type);
    }

    if (stmt.properties) {
      for (const [name, propType] of type.properties) {
        const propNode = propType.node;

        if ("decorators" in propNode) {
          for (const dec of propNode.decorators) {
            executeDecorator(dec, program, propType);
          }
        }
      }
    }
  }

  function executeDecorators(type: Type) {
    if ((<any>type.node).decorators) {
      for (const dec of (<any>type.node).decorators) {
        executeDecorator(dec, program, type);
      }
    }
  }

  function executeDecorator(dec: DecoratorExpressionNode, program: Program, type: Type) {
    if (dec.target.kind !== SyntaxKind.Identifier) {
      throwDiagnostic("Decorator must be identifier", dec);
    }

    const decName = dec.target.sv;
    const args = dec.arguments.map((a) => toJSON(checker.getTypeForNode(a)));
    const decBinding = <DecoratorSymbol>program.globalSymbols.get(decName);
    if (!decBinding) {
      throwDiagnostic(`Can't find decorator ${decName}`, dec);
    }
    const decFn = decBinding.value;
    decFn(program, type, ...args);
  }

  async function importDecorator(modulePath: string, name: string) {
    const resolvedPath = path.isAbsolute(modulePath)
      ? modulePath
      : path.resolve(process.cwd(), modulePath);

    const moduleUrl = url.pathToFileURL(resolvedPath);
    const module = await import(moduleUrl.href);
    return module[name];
  }

  /**
   * returns the JSON representation of a type. This is generally
   * just the raw type objects, but string and number literals are
   * treated specially.
   */
  function toJSON(type: Type): Type | string | number {
    if ("value" in type) {
      return (<any>type).value;
    }

    return type;
  }

  function dumpSymbols(program: Program) {
    for (const [binding, value] of program.globalSymbols) {
      console.log(`${binding} =>`);
      console.dir(value, { depth: 0 });
    }
  }

  /**
   * Binding creates symbol table entries for declared models
   * and interfaces.
   */

  async function loadStandardLibrary(program: Program) {
    await loadDirectory(program, resolvePath(import.meta.url, "../lib"));
    await loadDirectory(program, resolvePath(import.meta.url, "../../lib"));
  }

  async function loadDirectory(program: Program, rootDir: string) {
    const dir = await readdir(rootDir, { withFileTypes: true });
    for (const entry of dir) {
      if (entry.isFile()) {
        const path = join(rootDir, entry.name);
        if (entry.name.endsWith(".js")) {
          await loadJsFile(program, path);
        } else if (entry.name.endsWith(".adl")) {
          await loadAdlFile(program, path);
        }
      }
    }
  }

  async function loadAdlFile(program: Program, path: string) {
    const contents = await readFile(path, "utf-8");
    program.evalAdlScript(contents, path);
  }

  async function loadJsFile(program: Program, path: string) {
    const contents = await readFile(path, "utf-8");

    const exports = contents.match(/export function \w+/g);
    if (!exports) return;
    for (const match of exports) {
      // bind JS files early since this is the only work
      // we have to do with them.
      const name = match.match(/function (\w+)/)![1];
      const value = await importDecorator(path, name);

      if (name === "onBuild") {
        program.onBuild(value);
      } else {
        program.globalSymbols.set(name, {
          kind: "decorator",
          path,
          name,
          value,
        });
      }
    }
  }

  // Evaluates an arbitrary line of ADL in the context of a
  // specified file path.  If no path is specified, use a
  // virtual file path
  function evalAdlScript(adlScript: string, filePath?: string): void {
    filePath = filePath ?? `__virtual_file_${++virtualFileCount}`;
    const unparsedFile = createSourceFile(adlScript, filePath);
    const ast = parse(unparsedFile);
    const sourceFile = {
      ...unparsedFile,
      ast,
      interfaces: [],
      models: [],
      symbols: new SymbolTable(),
    };

    program.sourceFiles.push(sourceFile);
    binder.bindSourceFile(program, sourceFile, true);
  }
}