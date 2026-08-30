import Link from "next/link";
import { CreateButton } from "../components/CreateButton";
import { PrimaryButton } from "../components/PrimaryButton";

export default function HomePage() {
  async function handleArchive() {
    await fetch("/api/items/archive", { method: "POST" });
  }

  return (
    <main>
      <h1>Welcome</h1>
      <CreateButton />
      <a href="/about" data-ai="about-link">
        About
      </a>
      <Link href="/contact">Contact us</Link>
      <PrimaryButton onClick={handleArchive}>Archive</PrimaryButton>
    </main>
  );
}
