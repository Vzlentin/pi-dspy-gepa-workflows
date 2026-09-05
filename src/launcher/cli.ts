#!/usr/bin/env node
import { launch } from "./launch.js";
try {
  await launch(process.argv.slice(2));
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
