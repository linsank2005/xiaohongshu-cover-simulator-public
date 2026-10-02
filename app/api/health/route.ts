import { APP_ID, APP_VERSION, workspaceFingerprint } from "@/lib/app-identity";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() { return Response.json({ app: APP_ID, version: APP_VERSION, workspace: workspaceFingerprint() }, { headers: { "Cache-Control": "no-store" } }); }
