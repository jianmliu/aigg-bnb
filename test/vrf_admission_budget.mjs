import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {AdmissionBudget} from '../gateway/admission-budget.mjs';
test('admission budget survives restart, deduplicates task intent and refuses overspend',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vrf-budget-'));try{
 const file=path.join(dir,'ledger.json'),b=new AdmissionBudget(file,10n);b.reserve('a',6n);b.reserve('a',6n);assert.throws(()=>b.reserve('b',5n),/budget/);
 const restart=new AdmissionBudget(file,10n);restart.reserve('a',6n);restart.reserve('b',4n);assert.throws(()=>restart.reserve('c',1n),/budget/);assert.throws(()=>restart.reserve('a',7n),/changed/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
