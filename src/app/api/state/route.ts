import { operatorRoute, json } from "@/server/http";
import { getState } from "@/server/app-state";

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Next passes the request; typed so tests can call GET(request)
export const GET = operatorRoute(async (_req: Request) => json(await getState()));
