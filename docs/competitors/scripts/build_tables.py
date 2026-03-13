#!/usr/bin/env python3
"""
Формирование сравнительных таблиц цен конкурентов.

Использование:
  python3 build_tables.py --input scratch/data/competitors-2024-01-15.json
  python3 build_tables.py  # использует последний файл из scratch/data/
"""

import argparse
import json
import os
from pathlib import Path
from datetime import datetime

DATA_DIR = Path(__file__).parent.parent.parent / 'scratch' / 'data'

OUR_PROJECTS = ['prostobox', 'pochtoy']

WEIGHT_RANGE = list(range(1, 26))
CATEGORIES = {
    'clothes':     'Одежда',
    'electronics': 'Электроника',
    'mixed':       'Смешанная',
}


def find_latest_file() -> Path:
    """Найти последний файл с данными конкурентов."""
    files = sorted(DATA_DIR.glob('competitors-*.json'), reverse=True)
    if not files:
        raise FileNotFoundError(f"Нет файлов competitors-*.json в {DATA_DIR}")
    return files[0]


def load_data(path: Path) -> dict:
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def build_comparison_table(data: dict, category: str) -> str:
    """Сформировать Markdown-таблицу для категории."""
    prices = data['prices']
    companies = sorted(prices.keys())

    header = f"## Сравнение цен: {CATEGORIES.get(category, category)}\n\n"
    header += f"Дата сбора: {data['collected_at'][:10]}\n\n"

    # Заголовок таблицы
    cols = ['Вес'] + companies
    table = '| ' + ' | '.join(cols) + ' |\n'
    table += '|' + '|'.join(['---'] * len(cols)) + '|\n'

    for weight in WEIGHT_RANGE:
        key = f'{weight}kg'
        row = [f'{weight} кг']
        for company in companies:
            price = prices.get(company, {}).get(category, {}).get(key)
            if price is not None:
                # Выделить наши проекты
                if company in OUR_PROJECTS:
                    row.append(f'**${price:.1f}**')
                else:
                    row.append(f'${price:.1f}')
            else:
                row.append('—')
        table += '| ' + ' | '.join(row) + ' |\n'

    return header + table


def build_position_analysis(data: dict, category: str) -> str:
    """Анализ позиционирования наших проектов."""
    prices = data['prices']

    analysis = f"## Позиционирование (категория: {CATEGORIES.get(category, category)})\n\n"

    for project in OUR_PROJECTS:
        if project not in prices:
            continue

        analysis += f"### {project.capitalize()}\n\n"

        for weight in [1, 5, 10, 15, 20, 25]:
            key = f'{weight}kg'
            our_price = prices[project].get(category, {}).get(key)
            if our_price is None:
                continue

            # Сравнить с конкурентами
            competitor_prices = []
            for company, comp_data in prices.items():
                if company in OUR_PROJECTS:
                    continue
                price = comp_data.get(category, {}).get(key)
                if price is not None:
                    competitor_prices.append((company, price))

            if competitor_prices:
                competitor_prices.sort(key=lambda x: x[1])
                cheapest = competitor_prices[0]
                position = sum(1 for _, p in competitor_prices if p < our_price) + 1

                analysis += f"- **{weight} кг:** ${our_price:.1f} | "
                analysis += f"Позиция: {position}/{len(competitor_prices)+1} | "
                analysis += f"Дешевле всего: {cheapest[0]} ${cheapest[1]:.1f}\n"

        analysis += '\n'

    return analysis


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', help='Путь к файлу с данными')
    parser.add_argument('--output', help='Путь для сохранения отчета (Markdown)')
    args = parser.parse_args()

    input_path = Path(args.input) if args.input else find_latest_file()
    print(f"Загружаем данные из {input_path}...")
    data = load_data(input_path)

    report = f"# Анализ цен конкурентов\n\n"
    report += f"Дата: {datetime.now().strftime('%Y-%m-%d %H:%M')}\n\n"
    report += f"---\n\n"

    for category in CATEGORIES:
        report += build_comparison_table(data, category)
        report += '\n---\n\n'

    for category in CATEGORIES:
        report += build_position_analysis(data, category)

    output_path = args.output or DATA_DIR / f"competitors-report-{datetime.now().strftime('%Y-%m-%d')}.md"
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(report)

    print(f"✓ Отчет сохранен в {output_path}")


if __name__ == '__main__':
    main()
