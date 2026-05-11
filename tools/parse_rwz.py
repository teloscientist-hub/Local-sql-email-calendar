#!/usr/bin/env python3
"""Parse a Microsoft Outlook .rwz (Rules Wizard export) file into JSON.

Ported from hughbe/OutlookRulesReader (Swift, MIT). Covers the rule element
types the .rwz format's pre-2018 vintage that older actually uses:
- moveToFolderAction (0x12C), deleteAction (0x12D), stopProcessingMoreRulesAction (0x142)
- fromCondition (0xCB), sentToCondition (0xCC)
- specificWordsInSubjectCondition (0xCD), specificWordsInBodyCondition (0xCE),
  specificWordsInSubjectOrBodyCondition (0xCF)
- specificWordsInRecipientsAddressCondition (0xE5), specificWordsInSendersAddressCondition (0xE6)
- specificWordsInMessageHeaderCondition (0xE8)
- applyCondition (0x190) and the trailing 0x64 element (mandatory, ignored)

Other identifiers are recorded with a raw-data hex sentinel so the parser
doesn't crash if the input file (or some other .rwz) has additional types.
"""

from __future__ import annotations

import argparse
import json
import re
import struct
import sys
from collections import Counter, OrderedDict
from pathlib import Path


# ---------------------------------------------------------------------------
# Stream helper
# ---------------------------------------------------------------------------


class Stream:
    def __init__(self, data: bytes):
        self.b = data
        self.p = 0

    def remaining(self) -> int:
        return len(self.b) - self.p

    def u8(self) -> int:
        v = self.b[self.p]
        self.p += 1
        return v

    def u16(self) -> int:
        v = struct.unpack_from('<H', self.b, self.p)[0]
        self.p += 2
        return v

    def u32(self) -> int:
        v = struct.unpack_from('<I', self.b, self.p)[0]
        self.p += 4
        return v

    def take(self, n: int) -> bytes:
        v = self.b[self.p:self.p + n]
        self.p += n
        return v

    def peek_u32(self) -> int:
        return struct.unpack_from('<I', self.b, self.p)[0]


def utf16_string(s: Stream) -> str:
    n = s.u8()
    if n == 0xFF:
        n = s.u16()
    return s.take(n * 2).decode('utf-16-le', errors='replace')


def ascii_string(s: Stream) -> str:
    n = s.u8()
    if n == 0xFF:
        n = s.u16()
    return s.take(n).decode('ascii', errors='replace')


# ---------------------------------------------------------------------------
# Identifier table (subset; all 78 codes from RuleElementIdentifier.swift)
# ---------------------------------------------------------------------------

ID_TO_NAME = {
    0x190: 'applyCondition',
    0x064: 'unknown0x64',
    # Conditions
    0x0C8: 'nameInToBoxCondition',
    0x0C9: 'sentOnlyToMeCondition',
    0x0CA: 'nameNotInToBoxCondition',
    0x0CB: 'fromCondition',
    0x0CC: 'sentToCondition',
    0x0CD: 'specificWordsInSubjectCondition',
    0x0CE: 'specificWordsInBodyCondition',
    0x0CF: 'specificWordsInSubjectOrBodyCondition',
    0x0D0: 'flaggedForActionCondition',
    0x0D2: 'importanceCondition',
    0x0D3: 'sensitivityCondition',
    0x0D7: 'assignedToCategoryCondition',
    0x0DC: 'automaticReplyCondition',
    0x0DE: 'hasAttachmentCondition',
    0x0DF: 'withSelectedPropertiesOfDocumentOrFormsCondition',
    0x0E0: 'sizeInSpecificRangeCondition',
    0x0E1: 'receivedInSpecificDateSpanCondition',
    0x0E2: 'nameInCcBoxCondition',
    0x0E3: 'nameInToOrCcBoxCondition',
    0x0E4: 'usesFormCondition',
    0x0E5: 'specificWordsInRecipientsAddressCondition',
    0x0E6: 'specificWordsInSendersAddressCondition',
    0x0E8: 'specificWordsInMessageHeaderCondition',
    0x0E9: 'exceptionListCondition',
    0x0EB: 'junkCondition',
    0x0EC: 'adultCondition',
    0x0ED: 'relevanceInSpecificRangeCondition',
    0x0EE: 'throughSpecifiedAccountCondition',
    0x0EF: 'onThisComputerOnlyCondition',
    0x0F0: 'senderInSpecifiedAddressBookCondition',
    0x0F1: 'whichIsAMeetingInvitationOrInviteCondition',
    0x0F3: 'alertCondition',
    0x0F4: 'specificInfoPathFormCondition',
    0x0F5: 'fromRSSFeedsWithSpecifiedTextInTitleCondition',
    0x0F6: 'assignedToAnyCategoryCondition',
    0x0F7: 'fromAnyRSSFeedCondition',
    # Actions
    0x12C: 'moveToFolderAction',
    0x12D: 'deleteAction',
    0x12E: 'forwardAction',
    0x12F: 'replyUsingTemplateAction',
    0x130: 'displayMessageInNewItemAlertWindowAction',
    0x131: 'flagAction',
    0x132: 'clearFlagAction',
    0x133: 'assignToCategoryAction',
    0x136: 'playSoundAction',
    0x137: 'markImportanceAction',
    0x138: 'markSensitivityAction',
    0x139: 'moveCopyToFolderAction',
    0x13A: 'notifyReadAction',
    0x13B: 'notifyDeliveredAction',
    0x13C: 'ccAction',
    0x13E: 'deferDeliveryAction',
    0x13F: 'performCustomActionAction',
    0x142: 'stopProcessingMoreRulesAction',
    0x143: 'doNotSearchForCommercialOrAdultContentAction',
    0x144: 'redirectAction',
    0x145: 'addToRelevanceAction',
    0x146: 'automaticReply',
    0x147: 'forwardAsAttachmentAction',
    0x148: 'printAction',
    0x149: 'startApplicationAction',
    0x14A: 'permanentlyDeleteAction',
    0x14B: 'runScriptAction',
    0x14C: 'markAsReadAction',
    0x14F: 'displayDesktopAlertAction',
    0x151: 'flagForFollowUpAction',
    0x152: 'clearCategoriesAction',
    0x153: 'applyRetentionPolicyAction',
    # Exceptions (0x1F4..0x21B) — kept generic; we treat them like conditions
    0x1F4: 'nameInToBoxException',
    0x1F5: 'sentOnlyToMeException',
    0x1F6: 'nameNotInToBoxException',
    0x1F7: 'fromException',
    0x1F8: 'toException',
    0x1F9: 'specificWordsInSubjectException',
    0x1FA: 'specificWordsInBodyException',
    0x1FB: 'specificWordsInSubjectOrBodyException',
    0x1FC: 'flaggedForActionException',
    0x1FE: 'importanceException',
    0x1FF: 'sensitivityConditionException',
    0x203: 'assignedToCategoryException',
    0x208: 'automaticReplyException',
    0x20A: 'hasAttachmentException',
    0x20B: 'withSelectedPropertiesOfDocumentOrFormsException',
    0x20C: 'sizeInSpecificRangeException',
    0x20D: 'receivedInSpecificDateSpanException',
    0x20E: 'nameInCcBoxException',
    0x20F: 'nameInToOrCcBoxException',
    0x210: 'usesFormException',
    0x211: 'specificWordsInRecipientsAddressException',
    0x212: 'specificWordsInSendersAddressException',
    0x213: 'specificWordsInMessageHeaderException',
    0x214: 'throughSpecifiedAccountException',
    0x215: 'senderInSpecifiedAddressBookException',
    0x216: 'whichIsAMeetingInvitationOrInviteException',
    0x218: 'specificInfoPathFormException',
    0x219: 'fromRSSFeedsWithSpecifiedTextInTitleException',
    0x21A: 'assignedToAnyCategoryException',
    0x21B: 'fromAnyRSSFeedException',
}

# How to bucket each identifier
EXCEPTION_IDS = set(range(0x1F4, 0x21C))
ACTION_IDS = set(range(0x12C, 0x154))


# ---------------------------------------------------------------------------
# Element data parsers
# ---------------------------------------------------------------------------


def parse_simple(s: Stream) -> dict:
    extended = s.u32()
    return {'extended': extended}


def parse_apply_condition(s: Stream) -> dict:
    extended = s.u32()
    reserved = s.u32()
    flags = s.u32()
    names = []
    if flags & 0x01:
        names.append('afterReceived')
    if flags & 0x04:
        names.append('afterSent')
    if flags & 0x08:
        names.append('afterServerReceived')
    return {'extended': extended, 'reserved': reserved, 'flags': flags, 'flag_names': names}


def parse_unknown_0x64(s: Stream) -> dict:
    extended = s.u32()
    reserved = s.u32()
    flags = s.u32()
    return {'extended': extended, 'reserved': reserved, 'flags': flags}


def parse_search_entry(s: Stream) -> dict:
    flags = s.u32()
    value = utf16_string(s)
    return {'flags': flags, 'value': value}


def parse_strings_list(s: Stream) -> dict:
    count = s.u32()
    entries = [parse_search_entry(s) for _ in range(count)]
    return {'count': count, 'entries': [e['value'] for e in entries]}


def parse_categories_list(s: Stream) -> dict:
    """Categories rule data — semicolon-joined UTF-16 string + trailing UInt32."""
    raw = utf16_string(s)
    trailing = s.u32()
    return {
        'raw': raw,
        'categories': [c for c in raw.split(';') if c],
        'trailing': trailing,
    }


# Common MAPI property tags
PT_UNSPECIFIED = 0x0000
PT_NULL = 0x0001
PT_I2 = 0x0002
PT_LONG = 0x0003
PT_R4 = 0x0004
PT_DOUBLE = 0x0005
PT_CURRENCY = 0x0006
PT_APPTIME = 0x0007
PT_ERROR = 0x000A
PT_BOOLEAN = 0x000B
PT_OBJECT = 0x000D
PT_I8 = 0x0014
PT_STRING8 = 0x001E
PT_UNICODE = 0x001F
PT_SYSTIME = 0x0040
PT_CLSID = 0x0048
PT_BINARY = 0x0102

PROPERTY_TAG_NAMES = {
    0x0FFF: 'PR_ENTRYID',
    0x0FF6: 'PR_INSTANCE_KEY',
    0x0FF8: 'PR_MAPPING_SIGNATURE',
    0x300B: 'PR_SEARCH_KEY',
    0x3001: 'PR_DISPLAY_NAME',
    0x3002: 'PR_ADDRTYPE',
    0x3003: 'PR_EMAIL_ADDRESS',
    0x39FE: 'PR_SMTP_ADDRESS',
    0x39FF: 'PR_7BIT_DISPLAY_NAME',
    0x0001: 'PR_TEMPLATEID',
    0x3005: 'PR_DEPTH',
    0x3A06: 'PR_GIVEN_NAME',
    0x6001: 'PR_RULE_PROVIDER',
}


def parse_properties_list(s: Stream) -> dict:
    """Parse one MAPI PropertiesList blob (used by PeopleOrPublicGroupListRuleElementData)."""
    unknown = s.u32()
    num_props = s.u32()
    block_size = s.u32()
    start_pos = s.p
    end_pos = start_pos + block_size

    headers = []
    for _ in range(num_props):
        tag = s.u32()
        d1 = s.u32()
        d2 = s.u32()
        d3 = s.u32()
        prop_type = tag & 0xFFFF
        prop_id = (tag >> 16) & 0xFFFF
        headers.append((prop_id, prop_type, d1, d2, d3))

    properties = OrderedDict()
    after_headers = s.p  # noqa: F841 — kept for future debugging

    for prop_id, prop_type, d1, d2, d3 in headers:
        name = PROPERTY_TAG_NAMES.get(prop_id, f'0x{prop_id:04X}')
        if prop_type == PT_LONG or prop_type == PT_ERROR:
            properties[name] = d2
        elif prop_type == PT_BOOLEAN:
            properties[name] = bool(d2 & 0xFFFF)
        elif prop_type in (PT_UNICODE, PT_STRING8, PT_BINARY):
            offset = d2
            if start_pos + offset > end_pos or offset > block_size:
                properties[name] = {'__error': f'bad offset {offset}', 'type': prop_type}
                continue
            saved = s.p
            s.p = start_pos + offset
            try:
                if prop_type == PT_UNICODE:
                    end = s.p
                    while end + 1 < end_pos and not (s.b[end] == 0 and s.b[end + 1] == 0):
                        end += 2
                    val = s.b[s.p:end].decode('utf-16-le', errors='replace')
                    properties[name] = val
                elif prop_type == PT_STRING8:
                    end = s.p
                    while end < end_pos and s.b[end] != 0:
                        end += 1
                    properties[name] = s.b[s.p:end].decode('latin-1', errors='replace')
                else:  # PT_BINARY
                    length = d3
                    properties[name] = '<bin:' + s.b[s.p:s.p + length].hex() + '>'
            finally:
                s.p = saved
        else:
            properties[name] = {'__type': f'0x{prop_type:04X}', 'd2': d2, 'd3': d3}

    s.p = end_pos
    return {'unknown': unknown, 'num_properties': num_props, 'properties': properties}


def parse_people_or_group_list(s: Stream) -> dict:
    extended = s.u32()
    reserved = s.u32()
    count = s.u32()
    values = [parse_properties_list(s) for _ in range(count)]
    unknown1 = s.u32()
    unknown2 = s.u32()

    summary = []
    for v in values:
        props = v['properties']
        display = props.get('PR_DISPLAY_NAME') or props.get('PR_7BIT_DISPLAY_NAME')
        addr = props.get('PR_SMTP_ADDRESS') or props.get('PR_EMAIL_ADDRESS')
        addr_type = props.get('PR_ADDRTYPE')
        summary.append({'display_name': display, 'address': addr, 'address_type': addr_type})

    return {
        'extended': extended,
        'reserved': reserved,
        'count': count,
        'recipients': summary,
        'raw_values': values,
        'unknown1': unknown1,
        'unknown2': unknown2,
    }


def extract_pst_path(blob: bytes) -> str | None:
    """Best-effort: scan a FlatEntry blob for an embedded UTF-16LE path ending in .pst/.ost."""
    text = blob.decode('utf-16-le', errors='ignore')
    matches = re.findall(r'[\\?A-Za-z0-9 :._@\\/-]{6,}\.(?:pst|ost)', text)
    if matches:
        return max(matches, key=len)
    return None


def parse_flat_entry(s: Stream) -> dict:
    length = s.u32()
    blob = s.take(length)
    pst = extract_pst_path(blob)
    return {'length': length, 'hex_preview': blob[:32].hex(), 'embedded_path': pst}


def parse_move_to_folder(s: Stream) -> dict:
    extended = s.u32()
    reserved = s.u32()
    folder_entry = parse_flat_entry(s)
    store_entry = parse_flat_entry(s)
    folder_name = utf16_string(s)
    secondary_user_store = s.u32()
    return {
        'extended': extended,
        'reserved': reserved,
        'folder_name': folder_name,
        'folder_entry': folder_entry,
        'store_entry': store_entry,
        'store_path': store_entry.get('embedded_path'),
        'secondary_user_store': bool(secondary_user_store),
    }


# Map identifier → parse function. Anything not listed is dispatched by class
# (StringsList for word/header conditions, Simple for boolean conditions, etc.).
SIMPLE_IDS = {
    0x0C8, 0x0C9, 0x0CA, 0x0DC, 0x0DE, 0x0E2, 0x0E3,
    0x0EF, 0x0F1, 0x0F6, 0x0F7,
    0x12D, 0x132, 0x13A, 0x13B, 0x142, 0x143,
    0x14A, 0x14C, 0x14F, 0x152,
    0x1F4, 0x1F5, 0x1F6, 0x208, 0x20A, 0x20E, 0x20F, 0x216, 0x21A, 0x21B,
}

STRINGS_LIST_IDS = {
    0x0CD, 0x0CE, 0x0CF, 0x0E5, 0x0E6, 0x0E8, 0x0F5,
    0x1F9, 0x1FA, 0x1FB, 0x211, 0x212, 0x213, 0x219,
}

PEOPLE_LIST_IDS = {
    0x0CB, 0x0CC, 0x12E, 0x13C, 0x144, 0x147, 0x1F7, 0x1F8,
}


def parse_element_data(identifier: int, s: Stream) -> dict:
    if identifier == 0x190:
        return parse_apply_condition(s)
    if identifier == 0x064:
        return parse_unknown_0x64(s)
    if identifier == 0x12C or identifier == 0x139:
        return parse_move_to_folder(s)
    if identifier == 0x133:
        return parse_categories_list(s)
    if identifier in SIMPLE_IDS:
        return parse_simple(s)
    if identifier in STRINGS_LIST_IDS:
        return parse_strings_list(s)
    if identifier in PEOPLE_LIST_IDS:
        return parse_people_or_group_list(s)
    raise NotImplementedError(
        f'Unhandled rule element identifier 0x{identifier:X} '
        f'({ID_TO_NAME.get(identifier, "?")})'
    )


# ---------------------------------------------------------------------------
# Header / footer / rule loop
# ---------------------------------------------------------------------------


def parse_rules_header(s: Stream) -> dict:
    """Outlook 2019 header: 4+4 sig/flags, 9×4 unknowns, 2 numberOfRules."""
    sig = s.u32()
    flags = s.u32()
    unknowns = [s.u32() for _ in range(9)]
    number_of_rules = s.u16()
    return {
        'signature': sig,
        'flags': flags,
        'unknowns': unknowns,
        'number_of_rules': number_of_rules,
        'version': 'outlook2019' if sig == 0x00140000 and flags == 0x06140000 else 'unknown',
    }


def parse_rule(s: Stream, index: int) -> dict:
    rule_signature = s.u32()
    name = utf16_string(s)
    enabled = s.u32() != 0
    unknown1 = s.u32()
    unknown2 = s.u32()
    unknown3 = s.u32()
    unknown4 = s.u32()
    data_size = s.u32()
    number_of_elements = s.u16()
    separator = s.u16()
    if separator == 0xFFFF:
        assert index == 0, f'0xFFFF separator on rule {index}, expected 0x8001'
        _padding = s.u16()
        class_name_length = s.u16()
        class_name = s.take(class_name_length).decode('ascii')
        assert class_name == 'CRuleElement', f'unexpected class {class_name!r}'
    elif separator == 0x8001:
        assert index != 0, '0x8001 separator on rule 0, expected 0xFFFF'
    else:
        raise ValueError(f'rule {index}: bad separator 0x{separator:X}')

    elements = []
    for i in range(number_of_elements):
        identifier = s.u32()
        try:
            data = parse_element_data(identifier, s)
            data_error = None
        except Exception as exc:
            data = None
            data_error = f'{type(exc).__name__}: {exc}'
        elements.append({
            'identifier': identifier,
            'name': ID_TO_NAME.get(identifier, f'unknown_0x{identifier:X}'),
            'data': data,
            'error': data_error,
        })
        if data_error:
            # Bail on this rule — without a length prefix we can't safely skip.
            raise RuntimeError(
                f'rule {index} element {i} (id 0x{identifier:X}): {data_error}'
            )
        if i != number_of_elements - 1:
            sep = s.u16()
            if sep != 0x8001:
                raise ValueError(
                    f'rule {index} element {i}: separator 0x{sep:X} (expected 0x8001)'
                )

    apply_cond = next((e for e in elements if e['identifier'] == 0x190), None)
    apply_flags = apply_cond['data']['flag_names'] if apply_cond else []

    conditions = []
    actions = []
    exceptions = []
    for e in elements:
        ident = e['identifier']
        if ident in (0x190, 0x064):
            continue
        if ident in EXCEPTION_IDS:
            exceptions.append(_pretty_element(e))
        elif ident in ACTION_IDS:
            actions.append(_pretty_element(e))
        else:
            conditions.append(_pretty_element(e))

    return {
        'index': index,
        'name': name,
        'enabled': enabled,
        'apply_condition': apply_flags,
        'conditions': conditions,
        'actions': actions,
        'exceptions': exceptions,
        'rule_signature': f'0x{rule_signature:08X}',
        'data_size': data_size,
        'number_of_elements': number_of_elements,
    }


def _pretty_element(e: dict) -> dict:
    """Trim raw fields out of element data for the JSON dump."""
    out = {'type': e['name'], 'identifier': f"0x{e['identifier']:X}"}
    data = e.get('data') or {}
    if e['name'] in ('moveToFolderAction', 'moveCopyToFolderAction'):
        out['folder_name'] = data.get('folder_name')
        out['store_path'] = data.get('store_path')
    elif 'recipients' in data:
        out['recipients'] = data['recipients']
    elif 'entries' in data:
        out['values'] = data['entries']
    elif 'categories' in data:
        out['categories'] = data['categories']
    elif e['name'] == 'unknown0x64':
        pass
    else:
        # Keep small flat dicts; drop anything large
        for k, v in data.items():
            if isinstance(v, (int, str, bool)) or v is None:
                out[k] = v
    return out


def parse_rules_footer(s: Stream) -> dict:
    template_dir_length_raw = s.u32()
    template_dir_length = min(template_dir_length_raw, 260)
    template_dir = s.take(template_dir_length * 2).decode('utf-16-le', errors='replace')
    creation_date = s.take(12).hex()
    trailing = s.u32()
    return {
        'template_directory': template_dir,
        'creation_date_raw': creation_date,
        'trailing': trailing,
        'remaining_bytes': s.remaining(),
    }


def parse_rwz(data: bytes) -> dict:
    s = Stream(data)
    header = parse_rules_header(s)
    rules = []
    for i in range(header['number_of_rules']):
        rules.append(parse_rule(s, i))
    footer = parse_rules_footer(s) if s.remaining() >= 16 else None
    return {
        'version': header['version'],
        'header': header,
        'rules': rules,
        'footer': footer,
        'bytes_remaining': s.remaining(),
    }


# ---------------------------------------------------------------------------
# Self-test (golden hex fixtures from ImportActionTests.swift)
# ---------------------------------------------------------------------------


def _hex(*rows: str) -> bytes:
    return bytes.fromhex(''.join(rows).replace(' ', ''))


GOLDEN_MOVE_TO_INBOX = _hex(
    "00 00 14 00 00 00 14 06 00 00 00 00 00 00 00 00",
    "00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00",
    "01 00 00 00 01 00 00 00 00 00 00 00 01 00 00 00",
    "14 00 08 52 00 55 00 4C 00 45 00 4E 00 41 00 4D",
    "00 45 00 01 00 00 00 00 00 00 00 00 00 00 00 00",
    "00 00 00 00 00 00 00 57 01 00 00 03 00 FF FF 00",
    "00 0C 00 43 52 75 6C 65 45 6C 65 6D 65 6E 74 90",
    "01 00 00 01 00 00 00 00 00 00 00 01 00 00 00 01",
    "80 64 00 00 00 01 00 00 00 00 00 00 00 01 00 00",
    "00 01 80 2C 01 00 00 01 00 00 00 00 00 00 00 2E",
    "00 00 00 00 00 00 00 59 DA 07 29 9D AF 5C 4A B2",
    "0C 8B 81 A7 8C 96 C0 01 00 C3 B6 8E 10 F7 75 11",
    "CE B4 CD 00 AA 00 BB B6 E6 00 00 00 00 00 0C 00",
    "00 CE 00 00 00 00 00 00 00 38 A1 BB 10 05 E5 10",
    "1A A1 BB 08 00 2B 2A 56 C2 00 00 70 73 74 70 72",
    "78 2E 64 6C 6C 00 00 00 00 00 00 00 00 E9 2F EB",
    "75 96 50 44 86 83 B8 7D E5 22 AA 49 48 00 00 43",
    "00 3A 00 5C 00 55 00 73 00 65 00 72 00 73 00 5C",
    "00 68 00 75 00 67 00 68 00 62 00 65 00 5C 00 41",
    "00 70 00 70 00 44 00 61 00 74 00 61 00 5C 00 4C",
    "00 6F 00 63 00 61 00 6C 00 5C 00 4D 00 69 00 63",
    "00 72 00 6F 00 73 00 6F 00 66 00 74 00 5C 00 4F",
    "00 75 00 74 00 6C 00 6F 00 6F 00 6B 00 5C 00 68",
    "00 75 00 67 00 68 00 62 00 65 00 6C 00 6C 00 61",
    "00 72 00 73 00 40 00 67 00 6D 00 61 00 69 00 6C",
    "00 2E 00 63 00 6F 00 6D 00 2E 00 6F 00 73 00 74",
    "00 00 00 05 49 00 6E 00 62 00 6F 00 78 00 00 00",
    "00 00 00 00 00 00 02 00 00 00 00 00 00 00 00 00",
    "00 00 00 00 00 00",
)

GOLDEN_DELETE = _hex(
    "00 00 14 00 00 00 14 06 00 00 00 00 00 00 00 00",
    "00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00",
    "01 00 00 00 01 00 00 00 00 00 00 00 01 00 00 00",
    "14 00 08 52 00 55 00 4C 00 45 00 4E 00 41 00 4D",
    "00 45 00 01 00 00 00 00 00 00 00 00 00 00 00 00",
    "00 00 00 00 00 00 00 40 00 00 00 03 00 FF FF 00",
    "00 0C 00 43 52 75 6C 65 45 6C 65 6D 65 6E 74 90",
    "01 00 00 01 00 00 00 00 00 00 00 01 00 00 00 01",
    "80 64 00 00 00 01 00 00 00 00 00 00 00 01 00 00",
    "00 01 80 2D 01 00 00 00 00 00 00 00 00 00 00 02",
    "00 00 00 00 00 00 00 00 00 00 00 00 00 00 00",
)


def self_test() -> bool:
    print('Running self-test...')
    ok = True

    parsed = parse_rwz(GOLDEN_MOVE_TO_INBOX)
    rule = parsed['rules'][0]
    assert rule['name'] == 'RULENAME', f'name was {rule["name"]!r}'
    assert len(rule['conditions']) == 0, rule
    assert len(rule['actions']) == 1, rule
    action = rule['actions'][0]
    assert action['type'] == 'moveToFolderAction', action
    assert action['folder_name'] == 'Inbox', action
    print('  testMoveToFolderAction OK')

    parsed = parse_rwz(GOLDEN_DELETE)
    rule = parsed['rules'][0]
    assert rule['name'] == 'RULENAME', rule['name']
    assert len(rule['conditions']) == 0, rule
    assert len(rule['actions']) == 1, rule
    assert rule['actions'][0]['type'] == 'deleteAction', rule['actions'][0]
    print('  testDeleteAction OK')

    return ok


# ---------------------------------------------------------------------------
# Summary writer
# ---------------------------------------------------------------------------


def _short(values, limit=80):
    s = ', '.join(str(v) for v in values)
    return s if len(s) <= limit else s[:limit - 1] + '…'


def _recipient_label(rec: dict) -> str:
    """Pick the most informative string for a recipient (address or display name)."""
    addr = rec.get('address')
    if isinstance(addr, str) and addr:
        return addr
    name = rec.get('display_name')
    if isinstance(name, str) and name:
        return name
    return str(addr) if addr is not None else '?'


def write_summary(parsed: dict, path: Path) -> None:
    rules = parsed['rules']
    folder_counter = Counter()
    store_counter = Counter()
    actions_counter = Counter()

    lines = []
    lines.append('# Outlook .rwz dump — derived summary\n')
    lines.append(f'- Source file version: **{parsed["version"]}**')
    lines.append(f'- Total rules: **{len(rules)}**')
    if parsed.get('footer'):
        td = parsed['footer'].get('template_directory') or '(empty)'
        lines.append(f'- Template directory in footer: `{td}`')
    lines.append('')
    lines.append('## Rules')
    lines.append('')
    lines.append('| # | Enabled | Name | Apply | Action(s) | Destination | Triggers |')
    lines.append('|---|---------|------|-------|-----------|-------------|----------|')

    for r in rules:
        name = r['name'].replace('|', '\\|')
        enabled = 'on' if r['enabled'] else 'off'
        apply = ','.join(r['apply_condition'])

        action_descs = []
        destinations = []
        for a in r['actions']:
            actions_counter[a['type']] += 1
            if a['type'] in ('moveToFolderAction', 'moveCopyToFolderAction'):
                folder = a.get('folder_name') or '?'
                store = a.get('store_path') or ''
                folder_counter[folder] += 1
                if store:
                    store_counter[store] += 1
                action_descs.append('move')
                destinations.append(folder)
            elif a['type'] == 'deleteAction':
                action_descs.append('delete')
                destinations.append('(Deleted Items)')
            elif a['type'] == 'permanentlyDeleteAction':
                action_descs.append('hard-delete')
                destinations.append('(purged)')
            elif a['type'] == 'stopProcessingMoreRulesAction':
                action_descs.append('stop')
            else:
                action_descs.append(a['type'])

        triggers = []
        for c in r['conditions']:
            t = c['type']
            if 'Sender' in t or t == 'fromCondition':
                addrs = []
                if 'recipients' in c:
                    addrs = [_recipient_label(x) for x in c['recipients']]
                elif 'values' in c:
                    addrs = c['values']
                triggers.append(f'from: {_short(addrs)}')
            elif 'Recipient' in t or t == 'sentToCondition':
                addrs = []
                if 'recipients' in c:
                    addrs = [_recipient_label(x) for x in c['recipients']]
                elif 'values' in c:
                    addrs = c['values']
                triggers.append(f'to: {_short(addrs)}')
            elif 'Subject' in t or 'Body' in t or 'MessageHeader' in t:
                vs = c.get('values', [])
                kind = (
                    'subj+body' if 'SubjectOrBody' in t else
                    'subj' if 'Subject' in t else
                    'body' if 'Body' in t else
                    'header'
                )
                triggers.append(f'{kind}: {_short([repr(v) for v in vs])}')
            else:
                triggers.append(t)
        triggers_str = '; '.join(triggers).replace('|', '\\|') or '—'

        lines.append(
            f'| {r["index"]} | {enabled} | {name} | {apply} | '
            f'{", ".join(action_descs)} | {", ".join(destinations) or "—"} | {triggers_str} |'
        )

    lines.append('')
    lines.append('## Destination folders')
    lines.append('')
    if folder_counter:
        for folder, n in sorted(folder_counter.items(), key=lambda kv: (-kv[1], kv[0])):
            lines.append(f'- `{folder}` — {n} rule(s)')
    else:
        lines.append('(none)')
    lines.append('')
    lines.append('## Destination stores (PST paths)')
    lines.append('')
    if store_counter:
        for store, n in sorted(store_counter.items(), key=lambda kv: (-kv[1], kv[0])):
            lines.append(f'- `{store}` — {n} rule(s)')
    else:
        lines.append('(none)')
    lines.append('')
    lines.append('## Action mix')
    lines.append('')
    for action, n in sorted(actions_counter.items(), key=lambda kv: (-kv[1], kv[0])):
        lines.append(f'- {action} × {n}')
    lines.append('')

    path.write_text('\n'.join(lines))


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('rwz', nargs='?', help='path to .rwz file')
    p.add_argument('--json', help='write JSON dump to this path')
    p.add_argument('--summary', help='write Markdown summary to this path')
    p.add_argument('--self-test', action='store_true', help='run golden-fixture tests and exit')
    args = p.parse_args(argv)

    if args.self_test:
        ok = self_test()
        return 0 if ok else 1

    if not args.rwz:
        p.error('expected an .rwz path (or --self-test)')

    data = Path(args.rwz).read_bytes()
    parsed = parse_rwz(data)

    if args.json:
        Path(args.json).write_text(json.dumps(parsed, indent=2, default=str))
        print(f'Wrote {args.json}')
    if args.summary:
        write_summary(parsed, Path(args.summary))
        print(f'Wrote {args.summary}')
    if not args.json and not args.summary:
        json.dump(parsed, sys.stdout, indent=2, default=str)
        print()

    return 0


if __name__ == '__main__':
    sys.exit(main())
