import Announce from "@/components/Announce";
import Nav from "@/components/Nav";
import Hero from "@/components/Hero";
import HowItWorks from "@/components/HowItWorks";
import LiveInApp from "@/components/LiveInApp";
import Agentic from "@/components/Agentic";
import Voice from "@/components/Voice";
import Features from "@/components/Features";
import Install from "@/components/Install";
import Deploy from "@/components/Deploy";
import Cli from "@/components/Cli";
import Closer from "@/components/Closer";
import Footer from "@/components/Footer";

export default function Home() {
  return (
    <>
      <Announce />
      <Nav />
      <Hero />
      <HowItWorks />
      <LiveInApp />
      <Agentic />
      <Voice />
      <Features />
      <Install />
      <Deploy />
      <Cli />
      <Closer />
      <Footer />
    </>
  );
}
