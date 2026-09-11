import Link from "next/link";
import { CreateButton } from "../components/CreateButton";
import { PrimaryButton } from "../components/PrimaryButton";

export default function HomePage() {
  async function handleArchive() {
    await fetch("/api/items/archive", { method: "POST" });
  }

  const showAddForm = false;

  return (
    <main>
      <h1>Welcome</h1>
      <CreateButton />
      <a href="/about" data-ai="about-link">
        About
      </a>
      <Link href="/contact">Contact us</Link>
      <PrimaryButton onClick={handleArchive}>Archive</PrimaryButton>
      <button>
        {showAddForm ? <span className="icon-x" /> : <span className="icon-plus" />}
        {showAddForm ? "Cancel" : "Add Patient"}
      </button>
      <input placeholder="Full name" />
      <button>
        <span>
          <div>Describe it — I'll build it</div>
          <div>Tell me about your business and what the agent should handle — optionally attach a pricing sheet, FAQ, or policy doc. I'll draft the name, personality, prompt, and greeting for you to review.</div>
        </span>
      </button>
    </main>
  );
}
