"""add explicit Supabase Auth subject mapping to users

Revision ID: f7a8b9c0d1e2
Revises: f6a7b8c9d0e1
Create Date: 2026-10-09 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa


revision = "f7a8b9c0d1e2"
down_revision = "f6a7b8c9d0e1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {column["name"] for column in inspector.get_columns("users")}
    if "supabase_user_id" not in columns:
        op.add_column(
            "users",
            sa.Column("supabase_user_id", sa.String(length=255), nullable=True),
        )

    indexes = {index["name"] for index in sa.inspect(bind).get_indexes("users")}
    if "ix_users_supabase_user_id" not in indexes:
        op.create_index(
            "ix_users_supabase_user_id",
            "users",
            ["supabase_user_id"],
            unique=True,
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "users" not in inspector.get_table_names():
        return

    indexes = {index["name"] for index in inspector.get_indexes("users")}
    if "ix_users_supabase_user_id" in indexes:
        op.drop_index("ix_users_supabase_user_id", table_name="users")

    columns = {column["name"] for column in sa.inspect(bind).get_columns("users")}
    if "supabase_user_id" in columns:
        op.drop_column("users", "supabase_user_id")
