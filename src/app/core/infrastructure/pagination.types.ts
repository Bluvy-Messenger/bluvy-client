export interface Paginated<T> {
  data:    T[];
  cursor:  string | null;
  hasMore: boolean;
}
