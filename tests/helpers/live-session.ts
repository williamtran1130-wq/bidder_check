import type { PGlite } from "@electric-sql/pglite";
/** Minimal Auth session schema for database fixtures, with real session rows. */
export async function installSessionTables(db: PGlite) {
  await db.exec(`create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id));
    create table auth.refresh_tokens(id bigserial primary key,user_id text,session_id uuid references auth.sessions(id) on delete cascade);`);
}
export async function fixtureSession(db: PGlite, id: string) {
  await db.exec("reset role");
  await db.query(
    "insert into auth.sessions(id,user_id) select id,id from auth.users where id=$1 on conflict do nothing",
    [id],
  );
  await db.query("select set_config('request.jwt.claims',$1,false)", [
    JSON.stringify({ sub: id, session_id: id, role: "authenticated" }),
  ]);
}
