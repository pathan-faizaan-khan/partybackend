import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../db/schema";
import * as rel from "../../db/relations";
import { env } from "../config/env";

const client = postgres(env.DATABASE_URL, { max: 10 });
export const db = drizzle(client, { schema: { ...schema, ...rel } });
