"use client";

import BlurText from "./BlurText";
import LanguageToggle from "@/components/ui/language-toggle";
import { useLanguage } from "@/components/ui/language-toggle";
import SpecularButton from "@/components/ui/specular-button";
import { siteCopy } from "@/lib/site-copy";
import { priceInfo } from "./price-config";
import LightRays from "./LightRays";
import {
  LivePriceDate,
  LivePriceFileLine,
  LivePriceFilename,
  LivePriceFormat,
  LiveNewItems,
} from "./live-price";

const telegramUrl = "https://t.me/unb_computers";
const whatsappUrl = "https://wa.me/996555342425";

type HomeContentProps = {
  initialNewItems: string[];
};

export default function HomeContent({ initialNewItems }: HomeContentProps) {
  const language = useLanguage();
  const copy = siteCopy[language];

  const scrollToPrice = () => {
    document.getElementById("price")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const downloadPrice = () => {
    const link = document.createElement("a");
    link.href = priceInfo.downloadUrl;
    link.download = "";
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  return (
    <main>
      <div className="announcement">
        <span className="announcement-dot" aria-hidden="true" />
        {copy.announcementUpdated} <LivePriceDate />
        <span className="announcement-divider" aria-hidden="true" />
        <span className="announcement-extra">{copy.announcementExtra}</span>
      </div>

      <header className="site-header">
        <a className="brand" href="#top" aria-label={copy.homeLabel}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="brand-logo" src="/unb-logo.png" alt="UnB computers" width="679" height="314" />
        </a>

        <nav className="nav-links" aria-label="Основная навигация">
          <a href="#price">{copy.navPrice}</a>
          <a href="#new-items">{copy.navNewItems}</a>
        </nav>

        <div className="header-tools">
          <LanguageToggle />
          <a className="header-action" href="#contact">
            {copy.contact} <span aria-hidden="true">↗</span>
          </a>
        </div>
      </header>

      <section className="hero shell" id="top">
        <div className="hero-copy">
          <div className="eyebrow">
            {copy.eyebrow.map((item) => <span key={item}>{item}</span>)}
          </div>
          <h1 aria-label={copy.heroTitle.join(" ")}>
            <BlurText text={copy.heroTitle[0]} delay={200} animateBy="words" direction="top" className="hero-blur-line" />
            <BlurText text={copy.heroTitle[1]} delay={350} animateBy="words" direction="top" className="hero-blur-line" />
            <BlurText text={copy.heroTitle[2]} delay={500} animateBy="words" direction="top" className="hero-blur-line hero-blur-accent" />
          </h1>
          <p className="hero-lead">{copy.heroLead}</p>
          <div className="hero-actions">
            <SpecularButton
              className="specular-price-button specular-price-button--hero"
              radius={2}
              tint="#ffbd1f"
              textColor="#071624"
              lineColor="#fff5c4"
              baseColor="#c28b00"
              intensity={0.8}
              shineSize={11}
              shineFade={34}
              thickness={1}
              speed={0.2}
              followMouse
              proximity={220}
              autoAnimate
              onClick={scrollToPrice}
            >
              <span>{copy.downloadPrice}</span>
              <span className="specular-price-button__arrow" aria-hidden="true">↓</span>
            </SpecularButton>
          </div>
        </div>

        <div className="hero-visual" aria-label={copy.heroVisualLabel}>
          <LightRays
            raysOrigin="top-center"
            raysColor="#ffbd1f"
            raysSpeed={0.55}
            lightSpread={0.82}
            rayLength={1.35}
            pulsating
            fadeDistance={1.1}
            followMouse
            mouseInfluence={0.08}
          />
          <div className="hero-grid" aria-hidden="true" />
          <div className="logo-panel">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/unb-logo.png"
              alt="Логотип UnB computers"
              width="679"
              height="314"
              loading="eager"
              fetchPriority="high"
              decoding="async"
            />
          </div>
          <div className="visual-caption"><span>UNB / 2026</span><span>BISHKEK, KG</span></div>
        </div>
      </section>

      <LiveNewItems initialItems={initialNewItems} />

      <section className="price-section shell" id="price">
        <div className="price-copy">
          <span className="section-kicker section-kicker-light">{copy.price.kicker}</span>
          <h2>{copy.price.title[0]}<br />{copy.price.title[1]}</h2>
          <p>{copy.price.description}</p>
        </div>

        <div className="price-window">
          <div className="window-bar">
            <div><i /><i /><i /></div>
            <LivePriceFilename />
            <span className="window-size"><LivePriceFormat /></span>
          </div>
          <div className="file-card">
            <div className="file-icon" aria-hidden="true">X</div>
            <div>
              <span className="file-label">{copy.price.fileLabel}</span>
              <h3>UnB computers</h3>
              <LivePriceFileLine />
            </div>
          </div>
          <div className="file-stats">
            <div><span>{copy.price.format}</span><b><LivePriceFormat /></b></div>
            <div><span>{copy.price.update}</span><b>{copy.price.frequency}</b></div>
            <div><span>{copy.price.access}</span><b>{copy.price.free}</b></div>
          </div>
          <SpecularButton
            className="specular-price-button specular-price-button--download"
            radius={2}
            tint="#ffbd1f"
            textColor="#071624"
            lineColor="#fff5c4"
            baseColor="#c28b00"
            intensity={0.8}
            shineSize={11}
            shineFade={34}
            thickness={1}
            speed={0.2}
            followMouse
            proximity={220}
            autoAnimate
            onClick={downloadPrice}
          >
            <span>{copy.price.download}</span>
            <span className="specular-price-button__arrow" aria-hidden="true">↓</span>
          </SpecularButton>
          <p className="file-note">{copy.price.note}</p>
        </div>
      </section>

      <section className="contact-section" id="contact">
        <div className="contact-inner shell">
          <div>
            <span className="section-kicker section-kicker-light">{copy.contactBlock.kicker}</span>
            <h2>{copy.contactBlock.title}<br /><em>{copy.contactBlock.accent}</em></h2>
          </div>
          <div className="contact-side">
            <p>{copy.contactBlock.description}</p>
            <div className="contact-buttons">
              <a href={telegramUrl} className="contact-button" target="_blank" rel="noopener noreferrer">
                <span className="contact-button__label">{copy.contactBlock.button}</span>
                <span className="contact-button__icon" aria-hidden="true">↗</span>
              </a>
              <a href={whatsappUrl} className="contact-button contact-button--whatsapp" target="_blank" rel="noopener noreferrer">
                <span className="contact-button__label">{copy.contactBlock.whatsappButton}</span>
                <span className="contact-button__icon" aria-hidden="true">↗</span>
              </a>
            </div>
          </div>
        </div>
      </section>

      <footer className="site-footer shell">
        <a className="brand brand-footer" href="#top" aria-label={copy.topLabel}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="brand-logo" src="/unb-logo.png" alt="UnB computers" width="679" height="314" />
        </a>
        <p>{copy.footerDescription}</p>
        <div><span>© 2026 UnB computers</span><a href="#top">{copy.backToTop}</a></div>
      </footer>
    </main>
  );
}
