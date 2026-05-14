#!/usr/bin/env python3
"""
Extract haulout data directly from Waterway Guide HTML files
"""
import argparse
import json
import re
import sqlite3
import sys
from pathlib import Path
from bs4 import BeautifulSoup


def extract_haulout_data(html_file):
    """Extract haulout data from a single HTML file"""
    with open(html_file, 'r', encoding='utf-8') as f:
        content = f.read()
    
    soup = BeautifulSoup(content, 'html.parser')
    
    # Extract basic marina info from title
    title = soup.find('title')
    if title:
        title_text = title.get_text()
    else:
        title_text = html_file.stem
    
    # Try to extract location from title
    location_match = re.search(r'([A-Z][a-z]+, [A-Z]{2})', title_text)
    location = location_match.group(1) if location_match else "Unknown"
    
    # Extract coordinates from schema
    lat = None
    lon = None
    schema_script = soup.find('script', type='application/ld+json')
    if schema_script:
        try:
            schema_data = json.loads(schema_script.string)
            for item in schema_data.get('@graph', []):
                if item.get('@type') == 'LocalBusiness':
                    geo = item.get('geo', {})
                    lat = geo.get('latitude')
                    lon = geo.get('longitude')
                    break
        except:
            pass
    
    # Extract haulout capabilities
    haulout_section = soup.find(string=re.compile('Haulout Capabilities', re.IGNORECASE))
    if not haulout_section:
        return None
    
    haulout_data = {
        'name': title_text.split('|')[1].strip() if '|' in title_text else title_text,
        'location': location,
        'lat': lat,
        'lon': lon,
        'has_travel_lift': False,
        'max_beam_ft': None,
        'max_tons': None,
        'haulout_details': {}
    }
    
    # Find the haulout section div
    haulout_div = haulout_section.find_parent('div')
    if not haulout_div:
        return None
    
    # Extract all haulout capability fields
    for div in haulout_div.find_all('div'):
        text = div.get_text(strip=True)
        if ':' in text:
            parts = text.split(':', 1)
            if len(parts) == 2:
                key = parts[0].strip()
                value = parts[1].strip()
                haulout_data['haulout_details'][key] = value
                
                if 'Travel Lift:' in text and value.lower() == 'yes':
                    haulout_data['has_travel_lift'] = True
                elif 'Travel Lift 2:' in text and value.lower() == 'yes':
                    haulout_data['has_travel_lift'] = True
    
    # Look for max beam in the entire document
    beam_patterns = [
        r'max\s*beam\s*[:\s]*(\d+(?:\.\d+)?)\s*ft',
        r'beam\s*[:\s]*(\d+(?:\.\d+)?)\s*ft',
        r'accommodate\s*.*?beam\s*[:\s]*(\d+(?:\.\d+)?)\s*ft',
        r'(\d+)\s*[\'"]\s*beam'
    ]
    
    for pattern in beam_patterns:
        matches = re.findall(pattern, content, re.IGNORECASE)
        if matches:
            haulout_data['max_beam_ft'] = float(matches[0])
            break
    
    # Look for ton capacity
    ton_patterns = [
        r'(\d+)\s*ton\s*travel\s*lift',
        r'travel\s*lift.*?(\d+)\s*ton',
        r'(\d+)\s*ton\s*capacity'
    ]
    
    for pattern in ton_patterns:
        matches = re.findall(pattern, content, re.IGNORECASE)
        if matches:
            haulout_data['max_tons'] = float(matches[0])
            break
    
    return haulout_data if haulout_data['has_travel_lift'] else None


def main():
    parser = argparse.ArgumentParser(description="Extract haulout data from Waterway Guide HTML files")
    parser.add_argument("--db-path", required=True, help="Path to SQLite database")
    parser.add_argument("--marina-dir", default="data/marina", help="Directory containing HTML files")
    parser.add_argument("--limit", type=int, help="Limit number of files to process")

    args = parser.parse_args()

    marina_dir = Path(args.marina_dir)
    if not marina_dir.exists():
        print(json.dumps({"error": f"Marina directory not found: {marina_dir}"}))
        sys.exit(1)

    # Get all HTML files
    html_files = list(marina_dir.glob("*.html"))
    if args.limit:
        html_files = html_files[:args.limit]

    print(f"Processing {len(html_files)} HTML files...")

    # Connect to database
    db_path = Path(args.db_path)
    conn = sqlite3.connect(str(db_path))
    cursor = conn.cursor()

    # Check if marinas table exists
    cursor.execute("""
        SELECT name FROM sqlite_master
        WHERE type='table' AND name='marinas'
    """)
    if cursor.fetchone() is None:
        print(json.dumps({"error": "marinas table does not exist in database"}))
        sys.exit(1)

    success_count = 0
    jacksonville_count = 0

    for html_file in html_files:
        # Extract marina UID from filename (e.g., 1-11073.html -> 1-11073)
        marina_uid = html_file.stem

        try:
            data = extract_haulout_data(html_file)
            if data:
                # Check if within 100 miles of Jacksonville (approx 30.33, -81.66)
                if data['lat'] and data['lon']:
                    jacksonville_lat = 30.33
                    jacksonville_lon = -81.66
                    distance = ((data['lat'] - jacksonville_lat)**2 + (data['lon'] - jacksonville_lon)**2)**0.5 * 69  # rough miles per degree
                    if distance <= 100:
                        jacksonville_count += 1
                        print(f"[JACKSONVILLE AREA] {data['name']} - Max Beam: {data['max_beam_ft']} ft - Distance: {distance:.1f} miles")

                # Update marinas table with haulout data
                tech_json = {
                    "haulout": {
                        "lift_capacity_tons": data.get('max_tons', 0),
                        "max_beam_ft": data.get('max_beam_ft', 0),
                        "dry_storage": data['haulout_details'].get('Dry Storage', 'No') == 'Yes'
                    },
                    "repairs": {
                        "hull": False,
                        "engine_inboard": False,
                        "engine_outboard": False,
                        "watermaker": False,
                        "solar_wind": False
                    }
                }
                
                cursor.execute(
                    "UPDATE marinas SET tech_json = ? WHERE marina_uid = ?",
                    (json.dumps(tech_json), marina_uid)
                )
                
                success_count += 1
                print(f"[{success_count}] Updated {marina_uid}: {data['name']} - Max Beam: {data['max_beam_ft']} ft")

        except Exception as e:
            print(f"[ERROR] {marina_uid}: {e}")

    conn.commit()
    conn.close()

    result = {
        "success": True,
        "total_files": len(html_files),
        "success_count": success_count,
        "jacksonville_area_count": jacksonville_count,
    }

    print(json.dumps(result, indent=2))
    sys.exit(0)


if __name__ == "__main__":
    main()
