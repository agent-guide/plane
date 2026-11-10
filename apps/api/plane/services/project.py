# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Shared service layer for project operations.

Plane's upstream API exposes the same business action through three parallel
view surfaces (``app`` session-auth, ``api`` API-key-auth, ``space`` public).
Historically each surface re-implemented the creation orchestration, which let
fixes drift between copies (see the ghost-project transaction bug). New
multi-step project logic belongs here once; views only keep their
authentication, permission and serialization differences.
"""

# Django imports
from django.db import transaction

# Module imports
from plane.bgtasks.webhook_task import model_activity
from plane.db.models import (
    DEFAULT_STATES,
    EXTERNAL_STATE_SOURCE,
    ProjectMember,
    State,
)

# Administrator role (ROLE.ADMIN.value) used for the creator and the
# project lead on creation. Kept literal to avoid importing the app
# permissions module from a shared service.
PROJECT_CREATION_ROLE = 20


def create_project_with_defaults(*, serializer, actor, requested_data, origin):
    """Create a project plus its mandatory companions, atomically.

    Wraps the serializer save (project row + identifier), creator and project
    lead memberships and the default states in a single transaction so a
    failure at any step rolls everything back — otherwise a project row
    without a member row survives ("ghost project": invisible in
    member-filtered lists while still occupying the workspace-unique
    name/identifier).

    The activity-log task is deferred via ``transaction.on_commit`` so it
    never fires for a rolled-back creation; ``robust=True`` keeps a broker
    failure from turning a committed creation into a 500.

    Args:
        serializer: a *validated* ProjectSerializer/ProjectCreateSerializer
            that has not been saved yet.
        actor: the requesting User (becomes project administrator).
        requested_data: the raw request payload, forwarded to the activity log.
        origin: base_host string for links in the activity log.

    Returns:
        The saved Project instance.
    """
    with transaction.atomic():
        serializer.save()
        project = serializer.instance

        # Add the creator as Administrator of the project.
        _ = ProjectMember.objects.create(
            project_id=project.id,
            member=actor,
            role=PROJECT_CREATION_ROLE,
        )

        # If a different project lead was provided, add them as Administrator
        # too. Compare ids (not model instances) so the FK column value is
        # used directly downstream.
        lead_id = project.project_lead_id
        if lead_id is not None and lead_id != actor.id:
            ProjectMember.objects.create(
                project_id=project.id,
                member_id=lead_id,
                role=PROJECT_CREATION_ROLE,
            )

        State.objects.bulk_create(
            [
                State(
                    name=state["name"],
                    color=state["color"],
                    project=project,
                    sequence=state["sequence"],
                    workspace=project.workspace,
                    group=state["group"],
                    default=state.get("default", False),
                    external_source=(
                        EXTERNAL_STATE_SOURCE if state.get("external_id") else None
                    ),
                    external_id=state.get("external_id"),
                    created_by=actor,
                )
                for state in DEFAULT_STATES
            ]
        )

        def _dispatch_model_activity():
            # Closure captures the locals at construction time; they are never
            # rebound, so late-binding is not a hazard. A plain function (not
            # functools.partial) is required because Django's robust on_commit
            # error logging reads ``func.__qualname__``.
            model_activity.delay(
                model_name="project",
                model_id=str(project.id),
                requested_data=requested_data,
                current_instance=None,
                actor_id=actor.id,
                slug=project.workspace.slug,
                origin=origin,
            )

        transaction.on_commit(_dispatch_model_activity, robust=True)

    return project
