export type Id = string;

/** Shared so server-created and browser-created rows have the same owner. */
export const LOCAL_USER_ID = "local";

export interface Owned {
  id: Id;
  userId: Id;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}
