import { HTTPException } from "hono/http-exception";
export const notFound = (message: string): never => {
  throw new HTTPException(404, { message });
};
export const conflict = (message: string): never => {
  throw new HTTPException(409, { message });
};
