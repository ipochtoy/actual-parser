#!/usr/bin/env python3
"""
Сбор цен конкурентов со всех сайтов.

Использование:
  python3 collect_all.py          # Полный сбор (нужен CDP для Polexp/Easyship)
  python3 collect_all.py --no-cdp # Только сайты без CDP
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

# Список конкурентов
COMPETITORS = {
    'qwintry':    {'url': 'https://qwintry.com',    'cdp': False},
    'shopfans':   {'url': 'https://shopfans.ru',    'cdp': False},
    'cdek':       {'url': 'https://cdek.ru',        'cdp': False},
    'litemf':     {'url': 'https://litemf.com',     'cdp': False},
    'fishisfast': {'url': 'https://fishisfast.com', 'cdp': False},
    'undbox':     {'url': 'https://undbox.com',     'cdp': False},
    'easyship':   {'url': 'https://easyship.com',   'cdp': True},
    'polexp':     {'url': 'https://polexp.com',     'cdp': True},
}

WEIGHT_RANGE = list(range(1, 26))  # 1-25 кг
CATEGORIES = ['clothes', 'electronics', 'mixed']

OUTPUT_DIR = Path(__file__).parent.parent.parent / 'scratch' / 'data'


def check_cdp():
    """Проверить доступность CDP."""
    import urllib.request
    try:
        with urllib.request.urlopen('http://127.0.0.1:9222/json/version', timeout=3) as r:
            return r.status == 200
    except Exception:
        return False


def collect_without_cdp(name: str, config: dict) -> dict:
    """Сбор цен без CDP (публичные страницы/калькуляторы)."""
    print(f"  Собираем {name}...")
    prices = {}

    # TODO: Реализовать для каждого конкурента
    # Здесь должна быть логика парсинга калькулятора цен
    # Каждый конкурент имеет свою структуру страницы

    for category in CATEGORIES:
        prices[category] = {}
        for weight in WEIGHT_RANGE:
            # Заглушка — реальная реализация под каждый сайт
            prices[category][f'{weight}kg'] = None

    return prices


def collect_with_cdp(name: str, config: dict, cdp_ws_url: str) -> dict:
    """Сбор цен через CDP."""
    print(f"  Собираем {name} (CDP)...")
    prices = {}

    # TODO: Реализовать CDP-скрейпинг
    for category in CATEGORIES:
        prices[category] = {}
        for weight in WEIGHT_RANGE:
            prices[category][f'{weight}kg'] = None
        time.sleep(1)  # Anti-bot: не более 1 запроса в секунду

    return prices


def main():
    parser = argparse.ArgumentParser(description='Сбор цен конкурентов')
    parser.add_argument('--no-cdp', action='store_true', help='Только без CDP')
    parser.add_argument('--output', help='Путь для сохранения результатов')
    args = parser.parse_args()

    results = {
        'collected_at': datetime.now().isoformat(),
        'prices': {}
    }

    cdp_available = False
    cdp_ws_url = None

    if not args.no_cdp:
        cdp_available = check_cdp()
        if cdp_available:
            print("✓ CDP доступен")
        else:
            print("⚠️  CDP недоступен. CDP-сайты (Polexp, Easyship) будут пропущены.")
            print("   Для сбора всех данных запустите Chrome с CDP.")

    for name, config in COMPETITORS.items():
        needs_cdp = config['cdp']

        if needs_cdp and (args.no_cdp or not cdp_available):
            print(f"  Пропускаем {name} (требует CDP)")
            continue

        try:
            if needs_cdp:
                prices = collect_with_cdp(name, config, cdp_ws_url)
            else:
                prices = collect_without_cdp(name, config)

            results['prices'][name] = prices
            print(f"  ✓ {name}")
        except Exception as e:
            print(f"  ✗ {name}: {e}")

    # Сохранение результатов
    output_path = args.output or OUTPUT_DIR / f"competitors-{datetime.now().strftime('%Y-%m-%d')}.json"
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    print(f"\n✓ Сохранено в {output_path}")
    print(f"Собрано конкурентов: {len(results['prices'])}/{len(COMPETITORS)}")


if __name__ == '__main__':
    main()
