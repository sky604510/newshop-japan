import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const {PGlite}=createRequire(import.meta.url)('@electric-sql/pglite');
const db=new PGlite();
try {
  await db.exec("create table public.markets(id integer primary key,image_url text); insert into public.markets values (1,'original.png')");
  const migration=await readFile(new URL('../supabase/market_cover_layout_upgrade.sql',import.meta.url),'utf8');
  await db.exec(migration);await db.exec(migration);
  assert.deepEqual((await db.query('select * from markets')).rows[0],{id:1,image_url:'original.png',cover_layout:null});
  await db.query('update markets set cover_layout=$1::jsonb',[JSON.stringify({zoom:1.75,y:80})]);
  for(const value of [{zoom:0.5,y:50},{zoom:4,y:50},{zoom:1,y:101},{zoom:1},[],{zoom:'1',y:50}]) await assert.rejects(db.query('update markets set cover_layout=$1::jsonb',[JSON.stringify(value)]));
  assert.equal((await db.query('select image_url from markets')).rows[0].image_url,'original.png');
  console.log('PASS migration: repeat execution, preserve original images, save layout, reject invalid settings');
} finally {await db.close();}
