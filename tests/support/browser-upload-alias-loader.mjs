const projectRoot = new URL("../../", import.meta.url);
const dbStub =
  "data:text/javascript," +
  encodeURIComponent(
    "export function getDb() { throw new Error('getDb is not available in this unit test'); }",
  );

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@/db") {
    return { shortCircuit: true, url: dbStub };
  }
  if (specifier.startsWith("@/")) {
    return nextResolve(
      new URL(`${specifier.slice(2)}.ts`, projectRoot).href,
      context,
    );
  }
  return nextResolve(specifier, context);
}
