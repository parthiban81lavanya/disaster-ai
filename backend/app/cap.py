"""CAP v1.2 generator (XML + JSON) with English / Tamil / Hindi message templates."""
from datetime import datetime, timedelta, timezone
from xml.sax.saxutils import escape

LANGS = {"en": "en-IN", "ta": "ta-IN", "hi": "hi-IN"}

HEADLINE = {
    "en": "CRITICAL FLOOD WARNING – Ward 14 Adyar Basin",
    "ta": "அதி தீவிர வெள்ள எச்சரிக்கை – வார்டு 14 அடையாறு படுகை",
    "hi": "गंभीर बाढ़ चेतावनी – वार्ड 14 अडयार बेसिन",
}


def message(lang, score, rain, river, danger, rate):
    if lang == "ta":
        return (f"[NDMA-SACHET / WARD-14] அதி தீவிர வெள்ள எச்சரிக்கை: அடையாறு ஆற்றின் நீர்மட்டம் {river:.2f} மீ "
                f"(அபாய அளவு {danger:.2f} மீ), மணிக்கு +{rate:.2f} மீ உயர்கிறது. மழை {rain:.1f} மிமீ/மணி. "
                f"தாழ்வான பகுதிகள் (செக்டர் D, E) உடனடியாக வெளியேறி பாதுகாப்பான முகாம்களுக்கு செல்லவும். "
                f"பச்சை வழித்தடம்: செக்டர் B → C. அவசர உதவி: 1070 / 112.")
    if lang == "hi":
        return (f"[NDMA-SACHET / WARD-14] गंभीर बाढ़ चेतावनी: अडयार नदी का जलस्तर {river:.2f} मी "
                f"(खतरे का निशान {danger:.2f} मी), +{rate:.2f} मी/घंटा की दर से बढ़ रहा है। वर्षा {rain:.1f} मिमी/घंटा। "
                f"निचले इलाके (सेक्टर D, E) तुरंत खाली करें और सुरक्षित शिविरों में जाएं। "
                f"सुरक्षित मार्ग: सेक्टर B → C। आपातकालीन सहायता: 1070 / 112।")
    return (f"[NDMA-SACHET / WARD-14] CRITICAL FLOOD WARNING: Adyar river at {river:.2f} m (danger mark {danger:.2f} m), "
            f"rising +{rate:.2f} m/hr. Rainfall {rain:.1f} mm/hr. AI flood-risk score {score:.0f}/100. "
            f"Residents of Sectors D & E (Canal Bank / Lowland) evacuate now to the nearest safe shelter. "
            f"Verified safe corridor: Sector B → Sector C. Emergency: 1070 / 112.")


def polygon_ward14():
    from .seed import LAT, LON
    return [[LON[0], LAT[0]], [LON[3], LAT[0]], [LON[3], LAT[2]], [LON[0], LAT[2]], [LON[0], LAT[0]]]


def build_cap_json(identifier, lang, body, sender="ward14.duty@gcc.tn.gov.in", severity="Extreme"):
    now = datetime.now(timezone.utc)
    return {
        "alert": {
            "identifier": identifier, "sender": sender, "sent": now.isoformat(), "status": "Actual", "msgType": "Alert",
            "scope": "Public",
            "info": [{
                "language": LANGS[lang], "category": ["Met", "Rescue"], "event": "Urban Flood",
                "responseType": ["Evacuate", "Shelter"], "urgency": "Immediate", "severity": severity,
                "certainty": "Likely", "expires": (now + timedelta(hours=6)).isoformat(),
                "senderName": "DisasterShield AI – Ward 14 Duty Officer", "headline": HEADLINE[lang],
                "description": body, "instruction": body,
                "area": {"areaDesc": "Ward 14 – Adyar Basin, Chennai", "polygon": " ".join(f"{la},{lo}" for lo, la in polygon_ward14())},
            }],
        }
    }


def build_cap_xml(identifier, lang, body, sender="ward14.duty@gcc.tn.gov.in", severity="Extreme"):
    j = build_cap_json(identifier, lang, body, sender, severity)["alert"]; i = j["info"][0]
    cats = "".join(f"<category>{c}</category>" for c in i["category"])
    resp = "".join(f"<responseType>{c}</responseType>" for c in i["responseType"])
    return (f'<?xml version="1.0" encoding="UTF-8"?>\n<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">'
            f'<identifier>{identifier}</identifier><sender>{sender}</sender><sent>{j["sent"]}</sent>'
            f'<status>Actual</status><msgType>Alert</msgType><scope>Public</scope>'
            f'<info><language>{i["language"]}</language>{cats}<event>{i["event"]}</event>{resp}'
            f'<urgency>Immediate</urgency><severity>{severity}</severity><certainty>Likely</certainty>'
            f'<expires>{i["expires"]}</expires><senderName>{escape(i["senderName"])}</senderName>'
            f'<headline>{escape(i["headline"])}</headline><description>{escape(body)}</description>'
            f'<instruction>{escape(body)}</instruction>'
            f'<area><areaDesc>{escape(i["area"]["areaDesc"])}</areaDesc><polygon>{i["area"]["polygon"]}</polygon></area>'
            f'</info></alert>')
