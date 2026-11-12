import { route, json } from "@/server/http";
import { publicConfig } from "@/server/config";

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Next passes the request; typed so tests can call GET(request)
export const GET = route(async (_req: Request) => json(publicConfig()));
