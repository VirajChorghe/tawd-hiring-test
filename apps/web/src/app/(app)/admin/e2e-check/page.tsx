import { redirect } from "next/navigation";

/* The Site check moved into System (29 September 2026). */
export default function Moved() {
  redirect("/admin/system#site-check");
}
