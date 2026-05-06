export function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    opencodeRoot: undefined,
    json: false,
    dryRun: false,
    help: false,
    unknown: [],
    errors: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--json") {
      options.json = true;
      continue;
    }
    if (value === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (value === "--help" || value === "-h") {
      options.help = true;
      continue;
    }
    if (value === "--opencode-root") {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) {
        options.errors.push("--opencode-root requiere una ruta");
        continue;
      }
      options.opencodeRoot = next;
      index += 1;
      continue;
    }
    options.unknown.push(value);
  }

  return options;
}

export function output(result, options = {}) {
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.message) console.log(result.message);
  if (Array.isArray(result.details)) {
    for (const line of result.details) console.log(`- ${line}`);
  }
}

export function fail(result, code = 1) {
  const error = new Error(result.message || "Command failed");
  error.exitCode = code;
  error.result = result;
  throw error;
}

export function printHelp(commandName) {
  console.log(
    `Usage: node ./scripts/${commandName}.mjs [--opencode-root /path/to/opencode] [--dry-run] [--json]`,
  );
}

export async function runCli(commandName, main) {
  const options = parseArgs();

  if (options.help) {
    printHelp(commandName);
    return;
  }

  if (options.errors.length > 0 || options.unknown.length > 0) {
    const details = [
      ...options.errors,
      ...options.unknown.map((value) => `argumento no soportado: ${value}`),
    ];
    const result = {
      message: `Parámetros inválidos para ${commandName}`,
      details,
    };
    output(result, options);
    process.exitCode = 2;
    return;
  }

  try {
    const result = await main(options);
    output(result, options);
  } catch (error) {
    const result = error?.result ?? {
      message: error instanceof Error ? error.message : String(error),
    };
    output(result, options);
    process.exitCode = error?.exitCode ?? 1;
  }
}
