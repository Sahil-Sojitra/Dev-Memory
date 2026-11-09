import { runApplication } from "./app.ts";

process.exitCode = await runApplication(process.env);
