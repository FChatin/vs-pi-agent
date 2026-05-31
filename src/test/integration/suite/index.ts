import * as path from 'path';
import Mocha from 'mocha';
import * as fs from 'fs';

export function run(): Promise<void> {
    const mocha = new Mocha({
        ui: 'bdd',
        color: true,
        timeout: 120_000,
    });

    const testsRoot = __dirname;
    const files = fs.readdirSync(testsRoot).filter(f => f.endsWith('.test.js'));

    for (const file of files) {
        mocha.addFile(path.resolve(testsRoot, file));
    }

    return new Promise((resolve, reject) => {
        mocha.run((failures) => {
            if (failures > 0) {
                reject(new Error(`${failures} test(s) failed.`));
            } else {
                resolve();
            }
        });
    });
}
