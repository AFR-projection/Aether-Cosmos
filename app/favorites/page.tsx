import { redirect } from "next/navigation";
import { FILES_FAVORITES_HREF } from "@files/domain/services/file-filter";

/**
 * Favorites is now a filter of My Files, not its own destination. The route stays
 * so old bookmarks and links land on the canonical view instead of a 404.
 */
export default function FavoritesPage() {
  redirect(FILES_FAVORITES_HREF);
}
