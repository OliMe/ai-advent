import { stdin, stdout } from 'node:process';
import { main, reportFatalError } from './index.ts';

main(process.argv, stdin, stdout).catch(reportFatalError);
