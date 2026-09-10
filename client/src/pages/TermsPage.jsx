/**
 * The terms of use — the page `/terms`, which the registration form has been linking to
 * since day one without it existing.
 *
 * THIS IS PLACEHOLDER TEXT AND SAYS SO, AT THE TOP, IN A BANNER. That is the entire
 * design decision worth defending here.
 *
 * The alternative — plausible-sounding legalese copied from somewhere — would be worse
 * than the 404 it replaces. Registration records WHICH version each person accepted
 * (`accepted_terms_version`), so the whole point of that column is being able to say
 * later exactly what somebody agreed to. Filling it with text nobody wrote and no
 * lawyer read would make that record confidently wrong, which is the one outcome the
 * version column exists to prevent.
 *
 * The version rendered here is fetched from the API rather than hardcoded, so this page
 * and the checkbox on the registration form can never disagree about what is current.
 */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Card } from "../components/ui/Card.jsx";
import { Alert } from "../components/ui/Alert.jsx";
import { Logo } from "../components/Logo.jsx";
import { api } from "../lib/api.js";

/** One section of the document. */
function Clause({ heading, children }) {
  return (
    <section className="mt-7">
      <h2 className="text-base font-semibold text-stone-900">{heading}</h2>
      <p className="mt-2 leading-relaxed text-stone-600">{children}</p>
    </section>
  );
}

export function TermsPage() {
  const [version, setVersion] = useState(null);

  useEffect(() => {
    let active = true;
    // Failure is silent and the page still renders. A terms page that refuses to show
    // its own text because a version string could not be fetched would be absurd.
    api
      .get("/auth/terms/current")
      .then((data) => active && setVersion(data.version))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="mx-auto w-full max-w-2xl">
      <div className="mb-8 flex justify-center">
        <Link to="/" aria-label="RentEasy home">
          <Logo />
        </Link>
      </div>

      <Card className="p-7 sm:p-9">
        <h1 className="text-2xl font-semibold tracking-tight text-stone-900">Terms of use</h1>
        <p className="mt-2 text-sm text-stone-500">
          {version ? `Version ${version}` : "Loading version…"}
        </p>

        <Alert tone="warning" className="mt-6">
          <div>
            <span className="font-medium">Placeholder text.</span> RentEasy is a portfolio
            project and this document has not been written or reviewed by anyone
            qualified to write it. It is here so the link on the sign-up form goes
            somewhere honest, not because it is enforceable.
          </div>
        </Alert>

        <Clause heading="1. What RentEasy is">
          A marketplace where people rent things to each other by the hour, the day or
          the month. RentEasy is not a party to any rental agreement — the arrangement is
          between the owner and the renter.
        </Clause>

        <Clause heading="2. Your account">
          You are responsible for what happens under your account and for keeping your
          password to yourself. Give accurate information, and keep your email address up
          to date — it is how you recover access.
        </Clause>

        <Clause heading="3. Listing something">
          List only things you own or have the right to rent out, describe them
          truthfully, and use photographs of the actual item. You set your own prices and
          decide who to rent to.
        </Clause>

        <Clause heading="4. Renting something">
          Return items on time and in the condition you received them. Damage, loss and
          late return are matters between you and the owner.
        </Clause>

        <Clause heading="5. Money">
          Prices, deposits and any negotiated amount are agreed between the two people
          involved. No payment processing exists yet.
        </Clause>

        <Clause heading="6. Your data">
          Your email address and phone number are never shown on your public profile.
          What a stranger can see is your display name, when you joined, and — once the
          rest of the marketplace exists — your listings and reviews.
        </Clause>

        <Clause heading="7. Changes to these terms">
          Each version has a date. The version you accepted when you signed up is
          recorded against your account, and a new version has to be accepted rather than
          applied to you silently.
        </Clause>

        <p className="mt-9 border-t border-stone-200 pt-6 text-sm text-stone-500">
          Questions about any of this belong with a real lawyer, not this page.{" "}
          <Link to="/register" className="font-medium text-brand-700 underline underline-offset-2">
            Back to sign up
          </Link>
        </p>
      </Card>
    </div>
  );
}
