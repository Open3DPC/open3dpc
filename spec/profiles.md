# Open3DPC application profiles

This is the application layer of [Open3DPC v2](v2.md). The physical layer ends at
[v2.md §9](v2.md#9-scanner-contract) step 10, having produced exactly two things:
the payload bits and their length. Everything from here on is decided by the
length.

## 1. Length is the namespace

Within one application every payload length is its own universe. A profile is
registered for **one exact length** and owns **every value of that length**, all
`2^length` patterns, and decides for itself how they are laid out:

- whether the profile carries a version field at all;
- if it does, how wide it is and where it sits;
- which values are assigned, which are reserved, and what "reserved" means.

Nothing about one length constrains another. One profile may spend three bits of
its nine on a version field; a sixteen-bit profile may spend five, or none. There
is no format-wide version, type or family field: the physical layer knows only
bits and a count.

## 2. Dispatch rules

A conforming application layer MUST:

1. Look the payload length up in its own list of profiles (§3).
2. If the length is not there, reject the scan. No profile runs.
3. Otherwise hand the payload to exactly that profile.

A conforming profile decoder MUST:

4. Accept a payload only when its length equals the profile's length. It MUST NOT
   zero-extend a shorter payload, truncate a longer one, or read any field before
   the length check has passed.
5. Reject any value its document marks reserved.
6. Never use anything but the payload bits as identity: not a printed caption, not
   the geometry, not the module size.

Rules 2 and 4 together are what keep "nine bits in an eleven-bit matrix" and
"eleven bits" distinct: they arrive with different lengths, and each profile sees
only its own.

## 3. Who owns a length

Open3DPC has no global registry, and a code does not say whose it is. Two
unrelated applications may both use fourteen bits. An application that can meet
other people's codes should expect that, and treat a decoded value as a key into
its own data, never as proof of origin.

For information: the [Enforso](https://enforso.com) apps use lengths 9 and 14,
the latter for numbered stickers.

## 4. Defining a profile

A profile document should state:

1. its exact length and complete bit layout;
2. every assigned and every reserved value, and its rejection rules;
3. at least one canonical example on at least one geometry;
4. test cases: valid, invalid, and invalid *length* (the length ± 1 at least), so
   that an implementation proves it dispatches on exact length.

A profile touches nothing in [v2.md](v2.md). If it appears to need a physical
change, the profile is wrong. Once codes are printed, do not reassign a length: a
retired profile's length stays rejected, so that a later one does not accept old
prints.

### Example: a fourteen-bit inventory number

```text
length      = 14
bits 0..13  = NUMBER, unsigned, most significant bit first
1 to 9999   = assigned
0           = reserved, reject
10000+      = reserved, reject
```

On a `4 × 6` matrix this profile accepts 9999 of the 2²³ patterns its 23 data and
CRC cells can hold, so a random pattern passes with probability of about 0.12 %.

## 5. Choosing a geometry for a profile

A profile of length `L` fits any v2 geometry with `payloadCapacity ≥ L`
([v2.md §4](v2.md#4-capacity-and-valid-geometries)). A profile SHOULD name a
reference geometry for printed goods, but the geometry is never part of its
identity: the same `L` bits on a taller matrix are the same value with a stronger
CRC and a different footprint. A profile decoder MUST NOT decide identity by `H`
or `W`.

A scanner MAY still be configured to accept only the geometries an application
prints. That is a filter in front of the profile, which lowers false accepts; it
decides whether a code is read, not what it means.
