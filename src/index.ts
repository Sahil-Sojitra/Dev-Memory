import { runStdio } from "./transports/stdio.ts";

process.exitCode = await runStdio(process.env);
