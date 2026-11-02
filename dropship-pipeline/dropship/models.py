"""Platform-neutral data types passed between suppliers, storefronts and workers."""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal


@dataclass
class SupplierVariant:
    variant_id: str
    sku: str
    name: str  # e.g. "Black / L"
    cost: Decimal
    stock: int
    image: str | None = None
    options: dict[str, str] = field(default_factory=dict)  # {"Color": "Black", "Size": "L"}
    weight_g: int | None = None


@dataclass
class SupplierProduct:
    product_id: str
    title: str
    description_html: str
    images: list[str]
    variants: list[SupplierVariant]
    category: str = ""
    shipping_cost: Decimal = Decimal("0")
    tags: list[str] = field(default_factory=list)


@dataclass
class StockLevel:
    variant_id: str
    stock: int
    cost: Decimal


@dataclass
class ShippingAddress:
    name: str
    address1: str
    address2: str
    city: str
    province: str
    province_code: str
    zip: str
    country: str
    country_code: str
    phone: str
    email: str

    def missing_fields(self) -> list[str]:
        required = ["name", "address1", "city", "zip", "country_code"]
        return [f for f in required if not getattr(self, f)]


@dataclass
class OrderLine:
    sku: str
    supplier_variant_id: str
    quantity: int
    unit_cost: Decimal
    line_item_id: str = ""


@dataclass
class SupplierOrderResult:
    supplier_order_id: str
    total_cost: Decimal
    raw: dict = field(default_factory=dict)


@dataclass
class TrackingInfo:
    tracking_number: str
    carrier: str
    url: str
    status: str = ""


@dataclass
class ListingVariant:
    sku: str
    price: Decimal
    compare_at: Decimal | None
    quantity: int
    options: dict[str, str]
    image: str | None = None
    cost: Decimal | None = None


@dataclass
class Listing:
    title: str
    description_html: str
    images: list[str]
    tags: list[str]
    product_type: str
    vendor: str
    status: str  # ACTIVE | DRAFT
    variants: list[ListingVariant]


@dataclass
class CreatedVariant:
    sku: str
    variant_id: str
    inventory_item_id: str


@dataclass
class CreatedListing:
    product_id: str
    variants: list[CreatedVariant]
