#!/usr/bin/env python3
"""
Extract haulout/travel lift data from Waterway Guide HTML files
"""
import re
import json
from pathlib import Path
from bs4 import BeautifulSoup

def extract_haulout_data(html_file):
    """Extract haulout data from a single HTML file"""
    with open(html_file, 'r', encoding='utf-8') as f:
        content = f.read()
    
    soup = BeautifulSoup(content, 'html.parser')
    
    # Extract basic marina info
    title = soup.find('title')
    if title:
        title_text = title.get_text()
    else:
        title_text = html_file.stem
    
    # Try to extract location from title or schema
    location_match = re.search(r'([A-Z][a-z]+, [A-Z]{2})', title_text)
    location = location_match.group(1) if location_match else "Unknown"
    
    # Extract haulout capabilities
    haulout_section = soup.find(string=re.compile('Haulout Capabilities', re.IGNORECASE))
    if not haulout_section:
        return None
    
    haulout_data = {
        'name': title_text.split('|')[1].strip() if '|' in title_text else title_text,
        'location': location,
        'has_travel_lift': False,
        'max_beam_ft': None,
        'max_tons': None,
        'haulout_details': []
    }
    
    # Find the haulout section div
    haulout_div = haulout_section.find_parent('div')
    if not haulout_div:
        return None
    
    # Extract all haulout capability fields
    for div in haulout_div.find_all('div'):
        text = div.get_text(strip=True)
        if 'Travel Lift' in text and ':' in text:
            parts = text.split(':', 1)
            if len(parts) == 2:
                key = parts[0].strip()
                value = parts[1].strip()
                haulout_data['haulout_details'].append({key: value})
                
                if 'Travel Lift:' in text and value.lower() == 'yes':
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
        r'(\d+)\s*ton',
        r'(\d+)\s*ton\s*travel\s*lift'
    ]
    
    for pattern in ton_patterns:
        matches = re.findall(pattern, content, re.IGNORECASE)
        if matches:
            haulout_data['max_tons'] = float(matches[0])
            break
    
    return haulout_data if haulout_data['has_travel_lift'] else None

def main():
    marina_dir = Path('data/marina')
    
    all_haulout_data = []
    
    for html_file in marina_dir.glob('*.html'):
        try:
            data = extract_haulout_data(html_file)
            if data:
                all_haulout_data.append(data)
                print(f"Found haulout data: {data['name']} - {data['location']} - Max Beam: {data['max_beam_ft']}")
        except Exception as e:
            print(f"Error processing {html_file}: {e}")
    
    # Save results
    with open('haulout_data.json', 'w') as f:
        json.dump(all_haulout_data, f, indent=2)
    
    print(f"\nFound {len(all_haulout_data)} marinas with travel lifts")
    print(f"Data saved to haulout_data.json")

if __name__ == '__main__':
    main()
