export type FsEntry = { name: string; path: string; isRepo: boolean };
export type FsListing = {
  path: string;
  parent: string | null;
  home: string;
  isRepo: boolean;
  entries: FsEntry[];
  truncated: boolean;
};
