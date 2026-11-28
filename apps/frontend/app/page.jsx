import Link from "next/link";
import GradientASCII from "./landing/GradientASCII";
import TechText from "./landing/TechText";
import "./landing/landing.css";

const title = "Assignment";

export const metadata = { title: `${title} | Lomi Labs` };

export default function LandingPage() {
  return (
    <main className="assignment-landing">
      <div className="assignment-sky" aria-hidden="true">
        <GradientASCII shape="horizon" cellSize={18} density={0.8} dpr={1} />
      </div>
      <div className="assignment-entry">
        <h1 aria-label={title}>
          <TechText text={title} fontSize={150} color="#ffffff" accentColor="#a5d8ff" />
        </h1>
        <Link href="/workspace">Open workspace <span aria-hidden="true">→</span></Link>
      </div>
    </main>
  );
}
