from __future__ import annotations

import re
from typing import Optional
from urllib.parse import quote_plus, urljoin, urlparse


BLOCKED_RESOURCE_TYPES = {
    "image",
    "stylesheet",
    "font",
    "media",
}

BLOCKED_URL_KEYWORDS = (
    "google-analytics",
    "googletagmanager",
    "doubleclick",
    "facebook.net",
    "facebook.com/tr",
    "segment.io",
    "hotjar",
)


def _extract_search_term(marina_url: str) -> Optional[str]:
    if not isinstance(marina_url, str) or not marina_url.strip():
        return None

    parsed = urlparse(marina_url)
    netloc = parsed.netloc.lower()
    if not netloc:
        return None

    host = netloc.replace("www.", "")
    first_label = host.split(".")[0]
    if not first_label:
        return None

    term = re.sub(r"([a-z])([A-Z])", r"\1 \2", first_label)
    term = re.sub(r"[^a-z0-9\-\s]", " ", term, flags=re.IGNORECASE)
    term = re.sub(r"\s+", " ", term).strip()
    return term if term else None


def _is_dockwa_destination_url(url: str) -> bool:
    if not isinstance(url, str) or not url:
        return False

    parsed = urlparse(url)
    host = (parsed.netloc or "").lower()
    path = (parsed.path or "").lower()
    return "dockwa.com" in host and path.startswith("/explore/destination/")


def _to_absolute_marinas_url(href: str) -> str:
    return urljoin("https://marinas.com", href)


def find_dockwa_link_for_marina(marina_url: str, timeout_seconds: int) -> Optional[str]:
    search_term = _extract_search_term(marina_url)
    if search_term is None:
        return None

    try:
        from playwright.sync_api import sync_playwright
        from playwright_stealth import stealth_sync
    except Exception:
        return None

    import random
    search_url = f"https://marinas.com/search?q={quote_plus(search_term)}"
    timeout_ms = max(timeout_seconds, 5) * 1000

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            viewport={"width": 1920, "height": 1080},
            timezone_id="America/New_York"
        )
        page = context.new_page()
        # Apply stealth to avoid WAF detection
        stealth_sync(page)

        def intercept_route(route):
            req = route.request
            req_url = req.url.lower()
            if req.resource_type in BLOCKED_RESOURCE_TYPES:
                route.abort()
                return
            if any(token in req_url for token in BLOCKED_URL_KEYWORDS):
                route.abort()
                return
            route.continue_()

        try:
            page.route("**/*", intercept_route)
            page.goto(search_url, wait_until="domcontentloaded", timeout=timeout_ms)
            page.wait_for_timeout(random.randint(2000, 5000))

            marina_href: Optional[str] = None
            selectors = (
                ".marina-card a[href]",
                "a[href*='/marinas/']",
                "a[href*='/marina/']",
            )
            for selector in selectors:
                first = page.locator(selector).first
                if first.count() < 1:
                    continue
                href = first.get_attribute("href")
                if not isinstance(href, str) or not href.strip():
                    continue
                marina_href = href
                break

            if marina_href is None:
                return None

            marina_page_url = _to_absolute_marinas_url(marina_href)
            page.goto(marina_page_url, wait_until="domcontentloaded", timeout=timeout_ms)
            page.wait_for_timeout(700)

            dockwa_links = page.locator("a[href*='dockwa.com']")
            count = dockwa_links.count()
            for idx in range(count):
                href = dockwa_links.nth(idx).get_attribute("href")
                if not isinstance(href, str) or not href.strip():
                    continue
                absolute = urljoin(marina_page_url, href)
                if _is_dockwa_destination_url(absolute):
                    return absolute

            return None
        except Exception:
            return None
        finally:
            try:
                page.unroute("**/*")
            except Exception:
                pass
            context.close()
            browser.close()


def extract_website_from_marinas_page(marinas_url: str, timeout_seconds: int) -> Optional[str]:
    """
    Extract the marina's website URL from a marinas.com page.
    """
    if not isinstance(marinas_url, str) or not marinas_url.strip():
        return None

    try:
        from playwright.sync_api import sync_playwright
        from playwright_stealth import stealth_sync
    except Exception:
        return None

    import random
    timeout_ms = max(timeout_seconds, 5) * 1000

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            viewport={"width": 1920, "height": 1080},
            timezone_id="America/New_York"
        )
        page = context.new_page()
        # Apply stealth to avoid WAF detection
        stealth_sync(page)

        def intercept_route(route):
            req = route.request
            req_url = req.url.lower()
            if req.resource_type in BLOCKED_RESOURCE_TYPES:
                route.abort()
                return
            if any(token in req_url for token in BLOCKED_URL_KEYWORDS):
                route.abort()
                return
            route.continue_()

        try:
            page.route("**/*", intercept_route)
            page.goto(marinas_url, wait_until="domcontentloaded", timeout=timeout_ms)
            page.wait_for_timeout(random.randint(2000, 5000))

            # Try multiple selectors for website link
            selectors = (
                'a[href^="http"][href*="marina"], a[href^="http"][href*="marinas"]',
                'a[href^="http"]:not([href*="marinas.com"]):not([href*="dockwa.com"]):not([href*="facebook"])',
                '.website-link a[href^="http"]',
                'a[rel="external"][href^="http"]',
            )

            for selector in selectors:
                links = page.locator(selector)
                count = links.count()
                for idx in range(count):
                    href = links.nth(idx).get_attribute("href")
                    if not isinstance(href, str) or not href.strip():
                        continue
                    
                    # Filter out marinas.com, dockwa.com, social media
                    href_lower = href.lower()
                    if any(blocked in href_lower for blocked in ["marinas.com", "dockwa.com", "facebook.com", "twitter.com", "instagram.com"]):
                        continue
                    
                    # Return the first valid website URL
                    return href.strip()

            return None
        except Exception:
            return None
        finally:
            try:
                page.unroute("**/*")
            except Exception:
                pass
            context.close()
            browser.close()


def extract_contact_info_from_marinas_page(marinas_url: str, timeout_seconds: int) -> dict[str, Optional[str]]:
    """
    Extract contact info (phone, email, website) from a marinas.com page.
    Returns dict with 'phone', 'email', 'website' keys.
    """
    if not isinstance(marinas_url, str) or not marinas_url.strip():
        return {"phone": None, "email": None, "website": None}

    try:
        from playwright.sync_api import sync_playwright
        from playwright_stealth import stealth_sync
    except Exception:
        return {"phone": None, "email": None, "website": None}

    import random
    timeout_ms = max(timeout_seconds, 5) * 1000
    result = {"phone": None, "email": None, "website": None}

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            viewport={"width": 1920, "height": 1080},
            timezone_id="America/New_York"
        )
        page = context.new_page()
        # Apply stealth to avoid WAF detection
        stealth_sync(page)

        def intercept_route(route):
            req = route.request
            req_url = req.url.lower()
            if req.resource_type in BLOCKED_RESOURCE_TYPES:
                route.abort()
                return
            if any(token in req_url for token in BLOCKED_URL_KEYWORDS):
                route.abort()
                return
            route.continue_()

        try:
            page.route("**/*", intercept_route)
            page.goto(marinas_url, wait_until="domcontentloaded", timeout=timeout_ms)
            page.wait_for_timeout(random.randint(2000, 5000))

            # Extract website
            website_selectors = (
                'a[href^="http"][href*="marina"], a[href^="http"][href*="marinas"]',
                'a[href^="http"]:not([href*="marinas.com"]):not([href*="dockwa.com"]):not([href*="facebook"])',
                '.website-link a[href^="http"]',
                'a[rel="external"][href^="http"]',
            )

            for selector in website_selectors:
                links = page.locator(selector)
                count = links.count()
                for idx in range(count):
                    href = links.nth(idx).get_attribute("href")
                    if not isinstance(href, str) or not href.strip():
                        continue
                    
                    href_lower = href.lower()
                    if any(blocked in href_lower for blocked in ["marinas.com", "dockwa.com", "facebook.com", "twitter.com", "instagram.com"]):
                        continue
                    
                    result["website"] = href.strip()
                    break
                if result["website"]:
                    break

            # Extract phone
            phone_selectors = (
                'a[href^="tel:"]',
                '.phone, .phone-number',
                '[data-phone]',
            )

            for selector in phone_selectors:
                elements = page.locator(selector)
                count = elements.count()
                for idx in range(count):
                    element = elements.nth(idx)
                    href = element.get_attribute("href")
                    text = element.text_content()
                    
                    # Try href first (tel: links)
                    if href and href.startswith("tel:"):
                        phone = href.replace("tel:", "").strip()
                        if phone:
                            result["phone"] = phone
                            break
                    
                    # Try text content
                    if text and text.strip():
                        # Extract phone number from text
                        import re
                        phone_match = re.search(r'[\d\-\(\)\.\+\s]+', text.strip())
                        if phone_match:
                            phone = phone_match.group().strip()
                            if len(phone) >= 10:  # Minimum reasonable phone length
                                result["phone"] = phone
                                break
                if result["phone"]:
                    break

            # Extract email
            email_selectors = (
                'a[href^="mailto:"]',
                '.email, .email-address',
                '[data-email]',
            )

            for selector in email_selectors:
                elements = page.locator(selector)
                count = elements.count()
                for idx in range(count):
                    element = elements.nth(idx)
                    href = element.get_attribute("href")
                    text = element.text_content()
                    
                    # Try href first (mailto: links)
                    if href and href.startswith("mailto:"):
                        email = href.replace("mailto:", "").strip()
                        if email:
                            result["email"] = email
                            break
                    
                    # Try text content
                    if text and text.strip():
                        import re
                        email_match = re.search(r'[\w\.-]+@[\w\.-]+\.\w+', text.strip())
                        if email_match:
                            result["email"] = email_match.group().strip()
                            break
                if result["email"]:
                    break

            return result
        except Exception:
            return {"phone": None, "email": None, "website": None}
        finally:
            try:
                page.unroute("**/*")
            except Exception:
                pass
            context.close()
            browser.close()
