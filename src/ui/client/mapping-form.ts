import type { MappingInput } from "../validate.ts";

/** Omitted settings retain their server default/current value, including externally managed autolinks. */
export function mappingFormBody(fields: Pick<MappingInput, "ghRepoId" | "ghRepoFullName" | "planeProjectId" | "syncDirection" | "linkbackComments">,
  smartOverride: boolean | undefined): Partial<MappingInput> {
  return { ...fields, ...(smartOverride === undefined ? {} : { smartCommitsEnabled: smartOverride }) };
}
