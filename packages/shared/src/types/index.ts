// Structural helper types that aren't tied to a runtime schema.

/** Stable identifier for any record. */
export type Id = string;

/**
 * The single user every row belongs to until auth exists. Shared so a task the
 * server's agent creates is owned identically to one created in the browser —
 * two copies of this string would silently split ownership across stores.
 */
export const LOCAL_USER_ID = "local";

/**
 * Fields every *owned* (Plane A) record carries. `userId` is present from day
 * one so single-user today can become multi-user later without a migration.
 * See docs/ARCHITECTURE.md → "Build for one user, leave the door open."
 */
export interface Owned {
  id: Id;
  userId: Id;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}
