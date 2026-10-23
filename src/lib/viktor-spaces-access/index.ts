export { AuthStrategyRoutes } from "../../auth/AuthStrategyRoutes";
export {
  AuthenticatedAppRoutes,
  AuthenticatedRoutes,
} from "../../auth/authenticated/AuthenticatedAppRoutes";
export { PublicAppRoutes } from "../../auth/public/PublicAppRoutes";
export type { ViktorAuthJsProfile, ViktorAuthJsProvider } from "./authjs";
export {
  createViktorAuthJsProvider,
  VIKTOR_PUBLIC_CLIENT_SECRET,
} from "./authjs";
export {
  getEmailPasswordSignInAvailable,
  getViktorAuthBaseUrl,
  getViktorAuthClientId,
  getViktorSignInAvailable,
  getViktorSpaceAccessMode,
  getViktorSpacesAuthEnabled,
  getViktorSpacesSpaceId,
} from "./config";
export * from "./constants";
export type { ViktorSpaceAccessMode } from "./types";
export { ViktorProductAuthProvider } from "./ViktorProductAuthProvider";
export {
  useViktorSpaceAccess,
  ViktorSpaceAccessProvider,
} from "./ViktorSpaceAccessProvider";
