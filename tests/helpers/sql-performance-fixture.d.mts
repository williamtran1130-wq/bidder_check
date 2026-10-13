import type { PGlite } from "@electric-sql/pglite";

export interface FixtureActor {
  id: string;
  workspace: string;
  profile?: string;
  resume?: string;
}
export type FixtureActors = Record<string, FixtureActor>;
export function createFixture(
  count?: number,
): Promise<{ db: PGlite; actors: FixtureActors }>;
export function asActor(
  db: PGlite,
  actors: FixtureActors,
  name: string | null,
  service?: boolean,
): Promise<void>;
export function definition(db: PGlite, signature: string): Promise<string>;
export function apply(db: PGlite, file: string): Promise<void>;
export function median(samples: number[]): number;
