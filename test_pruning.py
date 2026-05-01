#!/usr/bin/env python3
"""
Test script for semantic noise reduction in marina markdown.
This tests the prune_marina_markdown function without modifying production code.
"""

import re
import sys
from pathlib import Path

# Add project to path
sys.path.insert(0, str(Path(__file__).parent))

from fuel_extractor.app.markdown_convert import fetch_full_site_markdown


def prune_marina_markdown(markdown: str) -> str:
    """
    Reduce token count and noise in stitched markdown before LLM processing.
    
    1. Keyword-Based Semantic Filter: Keep sections with data-dense keywords
    2. Regex Fluff Removal: Remove footers, navigation, empty structure
    3. Whitespace & Link Compression
    """
    
    # Data-dense keywords that indicate valuable content
    DATA_DENSE_KEYWORDS = [
        "slip", "rate", "ft", "beam", "lift", "haul", "launch",
        "bridge", "draft", "depth", "fee", "$", "metered",
        "catamaran", "multihull", "surcharge", "diy"
    ]
    
    # Step 1: Split into sections by ## headers
    sections = re.split(r'\n## ', markdown)
    filtered_sections = []
    
    # First section (before any ##) - always include if it has keywords
    first_section = sections[0] if sections else ""
    if any(keyword in first_section.lower() for keyword in DATA_DENSE_KEYWORDS):
        filtered_sections.append(first_section)
    
    # Process remaining sections
    for section in sections[1:]:
        # Check if section contains data-dense keywords
        section_lower = section.lower()
        if any(keyword in section_lower for keyword in DATA_DENSE_KEYWORDS):
            filtered_sections.append("## " + section)
    
    # Rejoin filtered sections
    markdown = "\n## ".join(filtered_sections)
    
    # Step 2: Regex Fluff Removal
    
    # Remove social/footer lines
    markdown = re.sub(
        r'^.*(follow us|copyright|all rights reserved|privacy policy|terms of use).*$', 
        '', 
        markdown, 
        flags=re.MULTILINE | re.IGNORECASE
    )
    
    # Remove repetitive navigation links (simplified - removes common nav patterns)
    markdown = re.sub(
        r'^\s*[\*\-\+]\s*\[(?:home|about|contact|news|blog|photos|directions|local info)\]\(.*\)\s*$',
        '',
        markdown,
        flags=re.MULTILINE | re.IGNORECASE
    )
    
    # Remove empty table structure lines
    markdown = re.sub(r'^[\s\|\-]*$', '', markdown, flags=re.MULTILINE)
    
    # Remove empty lines
    markdown = re.sub(r'\n\s*\n\s*\n', '\n\n', markdown)
    
    # Step 3: Whitespace & Link Compression
    
    # Collapse multiple spaces
    markdown = re.sub(r' +', ' ', markdown)
    
    # (Optional) Convert markdown links to text only
    # markdown = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', markdown)
    
    return markdown.strip()


def estimate_token_count(text: str) -> int:
    """Rough token estimation (4 chars ~= 1 token for typical text)."""
    return len(text) // 4


def main():
    print("Testing semantic noise reduction on Daytona Marina...")
    print("=" * 60)
    
    # Fetch full site markdown
    print("\n1. Fetching full site markdown...")
    original_md = fetch_full_site_markdown(
        'https://www.thedaytonamarina.com',
        timeout_seconds=60,
        max_pages=20
    )
    
    original_tokens = estimate_token_count(original_md)
    print(f"   Original markdown length: {len(original_md):,} chars")
    print(f"   Estimated tokens: {original_tokens:,}")
    
    # Apply pruning
    print("\n2. Applying semantic pruning...")
    pruned_md = prune_marina_markdown(original_md)
    
    pruned_tokens = estimate_token_count(pruned_md)
    print(f"   Pruned markdown length: {len(pruned_md):,} chars")
    print(f"   Estimated tokens: {pruned_tokens:,}")
    
    # Calculate savings
    chars_saved = len(original_md) - len(pruned_md)
    tokens_saved = original_tokens - pruned_tokens
    percent_saved = (chars_saved / len(original_md)) * 100
    
    print(f"\n3. Savings:")
    print(f"   Characters saved: {chars_saved:,} ({percent_saved:.1f}%)")
    print(f"   Tokens saved: {tokens_saved:,} ({percent_saved:.1f}%)")
    
    # Show sample of pruned content
    print(f"\n4. Sample of pruned markdown (first 1000 chars):")
    print("-" * 60)
    print(pruned_md[:1000])
    print("-" * 60)
    
    # Check if key pricing info is preserved
    print(f"\n5. Key content verification:")
    print(f"   Contains 'rates': {'rates' in pruned_md.lower()}")
    print(f"   Contains '$': {'$' in pruned_md}")
    print(f"   Contains 'lift': {'lift' in pruned_md.lower()}")
    print(f"   Contains 'ft': {'ft' in pruned_md.lower()}")
    
    print("\n" + "=" * 60)
    print("Test complete.")


if __name__ == "__main__":
    main()
