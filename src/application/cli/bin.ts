#!/usr/bin/env node
import { runCli } from './run-cli.ts';

if (import.meta.main) process.exitCode = await runCli();
