import { CreateButton } from "../components/CreateButton";

export default function HomePage() {
  return (
    <main>
      <h1>Welcome</h1>
      <CreateButton />
      <a href="/about" data-ai="about-link">
        About
      </a>
    </main>
  );
}
