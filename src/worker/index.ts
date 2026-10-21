// Module entry of the coach board Worker (wrangler.jsonc "main"). workerd treats every named export
// of this module as a handler, so the default export is the only one; the logic is in handler.ts.
import { handleRequest, type Env } from "./handler";

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};
