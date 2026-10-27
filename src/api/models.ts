import { publicJson, requestJson, type Session } from "./client.js";

export type Model = {
  id: string;
  name: string;
  object: "model";
  created: number;
  owned_by: string;
  provider: string;
  context_window: number;
  max_output_tokens: number | null;
  capabilities: string[];
  reasoning_efforts: string[] | null;
  reasoning_effort_default: string | null;
  description: string | null;
  currency: "usd" | "jpy";
  input_per_1m: string;
  output_per_1m: string;
  cached_input_per_1m: string | null;
};

type ModelList = { object: "list"; data: Model[] };

export async function listModels(session: Session | null, apiUrl: string): Promise<Model[]> {
  const body = session
    ? await requestJson<ModelList>(session, { path: "/v1/models" })
    : await publicJson<ModelList>(`${apiUrl}/v1/models`);
  return body.data;
}
