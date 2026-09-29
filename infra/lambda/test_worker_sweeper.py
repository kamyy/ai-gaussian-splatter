"""Unit tests for infra/lambda/worker_sweeper.py. Stdlib only, so CI's infra job runs them with the runner's own python3.

boto3 is replaced with a stub before the import, since the Lambda runtime supplies it and nothing here installs it.
"""

import os
import sys
import unittest
from datetime import UTC, datetime, timedelta
from unittest import mock

sys.modules["boto3"] = mock.MagicMock()

import worker_sweeper  # noqa: E402

NOW = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)


def reservation(*instances):
    return {"Instances": [{"InstanceId": instance_id, "LaunchTime": launched} for instance_id, launched in instances]}


class OverdueInstanceIdsTest(unittest.TestCase):
    def test_returns_only_instances_older_than_the_ceiling_across_reservations(self):
        reservations = [
            reservation(("i-old", NOW - timedelta(minutes=46)), ("i-young", NOW - timedelta(minutes=10))),
            reservation(("i-older", NOW - timedelta(hours=3))),
        ]

        self.assertEqual(
            worker_sweeper.overdue_instance_ids(reservations, NOW, timedelta(minutes=45)), ["i-old", "i-older"]
        )

    def test_keeps_an_instance_exactly_at_the_ceiling(self):
        reservations = [reservation(("i-edge", NOW - timedelta(minutes=45)))]

        self.assertEqual(worker_sweeper.overdue_instance_ids(reservations, NOW, timedelta(minutes=45)), [])


@mock.patch.dict(
    os.environ,
    {
        "MAX_AGE_MINUTES": "45",
        "WORKER_TAG_KEY": "Role",
        "WORKER_TAG_VALUE": "worker",
        "ALERT_TOPIC_ARN": "arn:aws:sns:us-west-2:123456789012:alerts",
    },
)
class HandlerTest(unittest.TestCase):
    def setUp(self):
        self.ec2 = mock.patch.object(worker_sweeper, "ec2").start()
        self.sns = mock.patch.object(worker_sweeper, "sns").start()
        self.addCleanup(mock.patch.stopall)

    def pages(self, *pages):
        self.ec2.get_paginator.return_value.paginate.return_value = [{"Reservations": page} for page in pages]

    def test_terminates_every_overdue_instance_and_emails_the_list(self):
        now = datetime.now(UTC)
        self.pages(
            [reservation(("i-old", now - timedelta(hours=1)))],
            [reservation(("i-young", now), ("i-older", now - timedelta(hours=2)))],
        )

        result = worker_sweeper.handler({}, None)

        self.assertEqual(result, {"terminated": ["i-old", "i-older"]})
        self.ec2.terminate_instances.assert_called_once_with(InstanceIds=["i-old", "i-older"])
        self.sns.publish.assert_called_once()
        self.assertIn("i-old, i-older", self.sns.publish.call_args.kwargs["Message"])

    def test_filters_on_the_worker_tag_and_live_states(self):
        self.pages()

        worker_sweeper.handler({}, None)

        filters = self.ec2.get_paginator.return_value.paginate.call_args.kwargs["Filters"]
        self.assertIn({"Name": "tag:Role", "Values": ["worker"]}, filters)
        self.assertIn({"Name": "instance-state-name", "Values": ["pending", "running"]}, filters)

    def test_does_nothing_when_no_instance_is_overdue(self):
        self.pages([reservation(("i-young", datetime.now(UTC)))])

        self.assertEqual(worker_sweeper.handler({}, None), {"terminated": []})
        self.ec2.terminate_instances.assert_not_called()
        self.sns.publish.assert_not_called()


if __name__ == "__main__":
    unittest.main()
