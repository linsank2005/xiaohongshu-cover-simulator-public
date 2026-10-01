import { getTest } from "@/lib/db";
import { loadReferenceLibrary } from "@/lib/reference-library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const test = await getTest(id);
  if (!test) return Response.json({ error: "测试不存在" }, { status: 404 });
  const referenceIds = test.referenceIds;
  const referenceById = new Map(loadReferenceLibrary().map((reference) => [reference.id, reference]));
  const candidates = test.candidates.map((candidate) => ({
    key: candidate.key,
    label: candidate.label,
    url: "/api/tests/" + id + "/cover?variant=" + encodeURIComponent(candidate.key)
  }));
  const references = referenceIds
    .map((referenceId) => referenceById.get(referenceId))
    .filter((reference): reference is NonNullable<typeof reference> => Boolean(reference))
    .map((reference) => ({ id: reference.id, label: reference.label, title: reference.title, url: `/reference-covers/${reference.fileName}` }));
  return Response.json({ candidates, uploadedCoverUrl: candidates[0]?.url ?? null, references }, { headers: { "Cache-Control": "no-store" } });
}
