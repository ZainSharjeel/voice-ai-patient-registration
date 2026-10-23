// The auth mode describes whether this app has user accounts — nothing else.
// Who can reach the deployed URL (gating) is enforced by the Viktor platform
// in front of the app and is invisible to this codebase.
export type ViktorSpaceAccessMode = "public" | "authenticated";
