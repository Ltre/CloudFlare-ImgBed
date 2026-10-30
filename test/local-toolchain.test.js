import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
const lock=JSON.parse(readFileSync(new URL('../package-lock.json',import.meta.url),'utf8'));

describe('local G1 test/build entrypoints',()=>{
  it('starts the Mocha executable declared by the lockfile package',()=>{
    const cli=lock.packages['node_modules/mocha']?.bin?.mocha;
    assert.equal(cli,'bin/mocha','Mocha v8 executable changed');
    assert.ok(pkg.scripts.test.endsWith('./node_modules/mocha/'+cli),
      'npm test must run the installed Mocha CLI, not a guessed file path');
    assert.match(pkg.scripts.test,/--import \.\/deploy\/server\/register\.mjs/,
      'Mocha must register the existing ESM loader');
  });
  it('approves the native dependency install scripts in the lockfile',()=>{
    for(const name of ['better-sqlite3','esbuild','workerd']){
      const locked=lock.packages['node_modules/'+name];
      assert.ok(locked?.hasInstallScript,name+' requires a native install script');
      assert.equal(pkg.allowScripts?.[name+'@'+locked.version],true,
        name+'@'+locked.version+' must be approved by npm v12 policy');
    }
  });
  it('offers a local Pages and Workers dry-run build',()=>{
    assert.match(pkg.scripts['build:local'],/wrangler pages functions build/);
    assert.match(pkg.scripts['build:local'],/wrangler deploy .*--dry-run/);
    assert.match(pkg.scripts['verify:local'],/npm run doctor:local/);
    assert.match(pkg.scripts['verify:local'],/npm run test:wrangler:local/);
  });
});
