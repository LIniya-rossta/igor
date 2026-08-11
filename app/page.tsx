import { priceInfo } from "./price-config";
import {
  LivePriceDate,
  LivePriceFileLine,
  LivePriceFilename,
  LivePriceFormat,
} from "./live-price";

const categories = [
  {
    index: "01",
    title: "Компьютеры",
    description: "Готовые рабочие станции, игровые сборки и офисные решения.",
  },
  {
    index: "02",
    title: "Комплектующие",
    description: "Процессоры, видеокарты, память, накопители и охлаждение.",
  },
  {
    index: "03",
    title: "Ноутбуки",
    description: "Модели для работы, учёбы, бизнеса и производительных задач.",
  },
  {
    index: "04",
    title: "Периферия",
    description: "Мониторы, клавиатуры, мыши, гарнитуры и сетевое оборудование.",
  },
];

const benefits = [
  ["Подбор под задачу", "Собираем решение под бюджет и реальные требования, без лишних компонентов."],
  ["Проверенные поставки", "Прозрачные позиции, гарантия и консультация до оформления заказа."],
  ["Для дома и бизнеса", "От одного устройства до комплексного оснащения офиса."],
];

const whatsappUrl =
  "https://wa.me/996555342425?text=" +
  encodeURIComponent(
    "Здравствуйте! Пишу с сайта UnB computers. Хочу уточнить цену и наличие.",
  );

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
          <a href="#catalog">Каталог</a>
          <a href="#price">Прайс-лист</a>
          <a href="#advantages">Почему мы</a>
        </nav>

        <a className="header-action" href="#contact">
          Связаться <span aria-hidden="true">↗</span>
        </a>
      </header>

      <section className="hero shell" id="top">
        <div className="hero-copy">
          <div className="eyebrow"><span>Техника</span><span>Комплектующие</span><span>Сервис</span></div>
          <h1>
            Технологии,
            <br />которые <em>работают.</em>
          </h1>
          <p className="hero-lead">
            Компьютеры, комплектующие и периферия для дома и бизнеса — с понятными
            ценами, гарантией и человеческой консультацией.
          </p>
          <div className="hero-actions">
            <a className="button button-primary" href={priceInfo.downloadUrl} download>
              Скачать прайс <span aria-hidden="true">↓</span>
            </a>
            <a className="button button-secondary" href="#catalog">
              Смотреть категории
            </a>
          </div>
          <div className="hero-proof" aria-label="Преимущества">
            <span><b>01</b> Актуальные цены</span>
            <span><b>02</b> Гарантия</span>
            <span><b>03</b> Быстрый подбор</span>
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
          <div className="availability-card">
            <span className="availability-icon" aria-hidden="true">✓</span>
            <span><b>Прайс актуален</b><small><LivePriceDate /></small></span>
          </div>
          <div className="visual-caption"><span>UNB / 2026</span><span>BISHKEK, KG</span></div>
        </div>
      </section>

      <section className="catalog-section" id="catalog">
        <div className="shell">
          <div className="section-heading section-heading-minimal">
            <h2>Каталог</h2>
            <a className="section-link" href={priceInfo.downloadUrl} download>
              Скачать прайс <span aria-hidden="true">↓</span>
            </a>
          </div>

          <div className="category-grid">
            {categories.map((category) => (
              <article className="category-card" key={category.index}>
                <div className="category-number">{category.index}</div>
                <div className="category-symbol" aria-hidden="true"><span /><span /></div>
                <h3>{category.title}</h3>
                <p>{category.description}</p>
                <a href={priceInfo.downloadUrl} download aria-label={`Скачать прайс: ${category.title}`}>
                  В прайс-листе <span aria-hidden="true">↗</span>
                </a>
              </article>
            ))}
          </div>
        </div>
      </section>

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

      <section className="advantages shell" id="advantages">
        <div className="section-heading section-heading-minimal">
          <h2>Почему UnB</h2>
        </div>
        <div className="benefit-list">
          {benefits.map(([title, description], index) => (
            <article className="benefit-row" key={title}>
              <span className="benefit-index">0{index + 1}</span>
              <h3>{title}</h3>
              <p>{description}</p>
              <span className="benefit-arrow" aria-hidden="true">↗</span>
            </article>
          ))}
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
              href={whatsappUrl}
              className="contact-button"
              target="_blank"
              rel="noopener noreferrer"
            >
              Написать в WhatsApp <span aria-hidden="true">↗</span>
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
