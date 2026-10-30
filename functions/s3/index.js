import { onRequest as handle } from './[[path]].js';
export async function onRequest(context) {
  return handle({ ...context, params: { path: [] } });
}
