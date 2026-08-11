import BlurText from "./BlurText";
import { priceInfo } from "./price-config";
import {
  LivePriceDate,
  LivePriceFileLine,
  LivePriceFilename,
  LivePriceFormat,
  LiveNewItems,
} from "./live-price";

const telegramUrl = "https://t.me/unb_computers";

export default function Home() {
  return (
    <main>
      <div className="announcement">
        <span className="announcement-dot" aria-hidden="true" />
        Прайс обновлён <LivePriceDate />
        <span className="announcement-divider" aria-hidden="true" />
        <span className="announcement-extra">Цены и наличие уточняйте у менеджера</span>
      </div>

      <header className="site-header">
        <a className="brand" href="#top" aria-label="UnB computers — на главную">
          <span className="brand-main">UnB</span>
          <span className="brand-sub">computers</span>
        </a>

        <nav className="nav-links" aria-label="Основная навигация">
          <a href="#price">Прайс-лист</a>
        </nav>

        <a className="header-action" href="#contact">
          Связаться <span aria-hidden="true">↗</span>
        </a>
      </header>

      <section className="hero shell" id="top">
        <div className="hero-copy">
          <div className="eyebrow"><span>Техника</span><span>Комплектующие</span><span>Сервис</span></div>
          <h1 aria-label="Технологии, которые работают.">
            <BlurText text="Технологии," delay={200} animateBy="words" direction="top" className="hero-blur-line" />
            <BlurText text="которые" delay={350} animateBy="words" direction="top" className="hero-blur-line" />
            <BlurText text="работают." delay={500} animateBy="words" direction="top" className="hero-blur-line hero-blur-accent" />
          </h1>
          <p className="hero-lead">
            Компьютеры, комплектующие и периферия для дома и бизнеса — с понятными
            ценами, гарантией и человеческой консультацией.
          </p>
          <div className="hero-actions">
            <a className="button button-primary" href="#price">
              Скачать прайс <span aria-hidden="true">↓</span>
            </a>
          </div>
        </div>

        <div className="hero-visual" aria-label="Фирменный знак UnB computers">
          <div className="hero-grid" aria-hidden="true" />
          <div className="logo-panel">
            {/* vinext currently renders next/image with a duplicate React hook context in dev. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/unb-logo.png"
              alt="Логотип UnB computers"
              width="633"
              height="627"
            />
          </div>
          <div className="visual-caption"><span>UNB / 2026</span><span>BISHKEK, KG</span></div>
        </div>
      </section>

      <LiveNewItems />

      <section className="price-section shell" id="price">
        <div className="price-copy">
          <span className="section-kicker section-kicker-light">Актуальный прайс</span>
          <h2>Один файл.<br />Всегда свежие цены.</h2>
          <p>
            Скачайте полный список товаров с артикулами, категориями, ценами,
            наличием и условиями гарантии. Формат открывается в Excel и Google Sheets.
          </p>
          <ul className="price-features">
            <li><span>✓</span> Удобная таблица с фильтрами</li>
            <li><span>✓</span> Цены в USD и KGS</li>
            <li><span>✓</span> Поддержка XLS и XLSX</li>
            <li><span>✓</span> Отдельная инструкция по обновлению</li>
          </ul>
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
              <span className="file-label">ПРАЙС-ЛИСТ</span>
              <h3>UnB computers</h3>
              <LivePriceFileLine />
            </div>
          </div>
          <div className="file-stats">
            <div><span>Формат</span><b><LivePriceFormat /></b></div>
            <div><span>Обновление</span><b>{priceInfo.updateFrequency}</b></div>
            <div><span>Доступ</span><b>Свободный</b></div>
          </div>
          <a className="download-button" href={priceInfo.downloadUrl} download>
            <span>Скачать актуальный прайс</span><b aria-hidden="true">↓</b>
          </a>
          <p className="file-note">После скачивания уточните финальную цену и наличие у менеджера.</p>
        </div>
      </section>

      <section className="contact-section" id="contact">
        <div className="contact-inner shell">
          <div>
            <span className="section-kicker section-kicker-light">Нужна помощь с выбором?</span>
            <h2>Расскажите задачу —<br /><em>подберём решение.</em></h2>
          </div>
          <div className="contact-side">
            <p>Напишите менеджеру, чтобы уточнить наличие, финальную цену и подобрать подходящее решение.</p>
            <a
              href={telegramUrl}
              className="contact-button"
              target="_blank"
              rel="noopener noreferrer"
            >
              Написать в Telegram <span aria-hidden="true">↗</span>
            </a>
          </div>
        </div>
      </section>

      <footer className="site-footer shell">
        <a className="brand brand-footer" href="#top" aria-label="UnB computers — наверх">
          <span className="brand-main">UnB</span>
          <span className="brand-sub">computers</span>
        </a>
        <p>Компьютеры и комплектующие для дома и бизнеса.</p>
        <div><span>© 2026 UnB computers</span><a href="#top">Наверх ↑</a></div>
      </footer>
    </main>
  );
}
